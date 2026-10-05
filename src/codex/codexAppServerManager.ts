import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";
import { hasProcessExited, terminateProcess } from "../util/spawn.js";

export interface CodexAppServerStatus {
  available: boolean;
  url?: string;
  listenUrl?: string;
  transport: "ws" | "http";
  pid?: number;
  startedByVibeCodex: boolean;
  mode: "disabled" | "manual" | "auto";
  lastError?: string;
  logDir?: string;
  details?: Record<string, unknown>;
}

interface ManagedProcess {
  child: ChildProcess;
  url: string;
  listenUrl: string;
  logDir: string;
  startedAt: string;
}

let managed: ManagedProcess | undefined;
let lastError: string | undefined;
let startPending: Promise<CodexAppServerStatus> | undefined;
let startPendingKey: string | undefined;

function fallbackDetails(details?: Record<string, unknown>) {
  return {
    recommendedExecutionMode: "codex-app-thread",
    fallbackExecutionModes: ["app-supervised", "codex-app-visible", "ghostty-visible"],
    noPasteRequires: "A healthy local Codex app-server managed by Vibe Codex or configured with CODEX_APP_SERVER_URL",
    ...(details ?? {}),
  };
}

function redact(config: Config, value: string): string {
  const secrets = [config.relayToken, config.urlToken].filter((secret): secret is string => !!secret && secret.length > 0);
  return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function assertLocalUrl(rawUrl: string, config: Config) {
  const parsed = new URL(rawUrl);
  if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new VibeError("CONFIG_ERROR", "Codex app-server URL must use HTTP(S)/WS(S) without embedded credentials.");
  if (!config.codexAppServerAllowPublicHost && !isLocalHost(parsed.hostname)) {
    throw new VibeError("CONFIG_ERROR", "Codex app-server must bind to 127.0.0.1/localhost unless CODEX_APP_SERVER_ALLOW_PUBLIC_HOST=true.", {
      host: parsed.hostname,
    });
  }
}

function makeListenUrl(config: Config): string {
  const host = config.codexAppServerHost || "127.0.0.1";
  if (!config.codexAppServerAllowPublicHost && !isLocalHost(host)) {
    throw new VibeError("CONFIG_ERROR", "Refusing to start Codex app-server on a public host.", { host });
  }
  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${config.codexAppServerTransport}://${authorityHost}:${config.codexAppServerPort}`;
}

function apiUrlFromListenUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString().replace(/\/+$/, "");
}

async function probeUrl(rawUrl: string, config: Config, budgetMs = 1_500): Promise<{ available: boolean; details?: Record<string, unknown>; error?: string }> {
  assertLocalUrl(rawUrl, config);
  const base = apiUrlFromListenUrl(rawUrl);
  const deadline = Date.now() + budgetMs;
  let last: string | undefined;
  // An explicit failed readiness endpoint must not be overridden by a healthy process endpoint.
  for (const candidate of ["/readyz", "/healthz", "/health", "/status"]) {
    if (Date.now() >= deadline) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(500, Math.max(1, deadline - Date.now())));
    try {
      const response = await fetch(`${base}${candidate}`, { headers: { accept: "application/json" }, signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        last = `HTTP ${response.status} from ${candidate}`;
        await response.body?.cancel();
        if (candidate === "/readyz" && response.status !== 404 && response.status !== 405) return { available: false, error: last };
        continue;
      }
      const reader = response.body?.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 64_000) throw new Error("Health response exceeded size limit.");
            chunks.push(Buffer.from(part.value));
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let payload: Record<string, unknown> = {};
      try { const parsed: unknown = text ? JSON.parse(text) : {}; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>; } catch { /* Some older versions return plain health text. */ }
      if (payload.ready === false || payload.healthy === false || ["not_ready", "notready", "starting", "error", "failed", "unhealthy"].includes(String(payload.status).toLowerCase())) return { available: false, error: `App-server reports not ready at ${candidate}` };
      // Availability alone does not establish that the user has logged in to Codex.
      return { available: true, details: { healthEndpoint: candidate, readiness: candidate === "/readyz" ? "ready" : "health-only", loginStatus: payload.authenticated === true || payload.loggedIn === true ? "logged-in" : payload.authenticated === false || payload.loggedIn === false ? "logged-out" : "unknown" } };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (candidate === "/readyz") return { available: false, error: last };
    } finally { clearTimeout(timer); }
  }
  return { available: false, error: last ?? "Health probe timed out." };
}

async function waitForHealthy(url: string, config: Config, child: ChildProcess, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    if (hasProcessExited(child) || !child.pid) break;
    const result = await probeUrl(url, config, Math.min(1_500, deadline - Date.now()));
    if (hasProcessExited(child)) break;
    if (result.available) return result;
    last = result.error;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server did not become ready after startup.", fallbackDetails({ lastError: last ?? lastError }));
}

async function tailFile(filePath: string, maxBytes = 16_000): Promise<string | undefined> {
  try {
    const stat = await fsp.stat(filePath);
    const handle = await fsp.open(filePath, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function startupLogDetails(config: Config, logDir: string) {
  const stdoutTail = await tailFile(path.join(logDir, "stdout.log"));
  const stderrTail = await tailFile(path.join(logDir, "stderr.log"));
  return {
    stdoutTail: stdoutTail ? redact(config, stdoutTail) : undefined,
    stderrTail: stderrTail ? redact(config, stderrTail) : undefined,
  };
}

function currentManagedStatus(config: Config): CodexAppServerStatus | undefined {
  if (!managed) return undefined;
  if (hasProcessExited(managed.child)) {
    managed = undefined;
    return undefined;
  }
  return {
    available: true,
    url: managed.listenUrl,
    listenUrl: managed.listenUrl,
    transport: config.codexAppServerTransport,
    pid: managed.child.pid,
    startedByVibeCodex: true,
    mode: config.codexAppServerMode,
    lastError,
    logDir: managed.logDir,
  };
}

export async function detectManagedCodexAppServer(config: Config): Promise<CodexAppServerStatus> {
  if (config.codexAppServerMode === "disabled") {
    return { available: false, transport: config.codexAppServerTransport, startedByVibeCodex: false, mode: config.codexAppServerMode, lastError: "CODEX_APP_SERVER_MODE=disabled", details: fallbackDetails() };
  }
  const current = currentManagedStatus(config);
  if (current) {
    const probe = await probeUrl(current.url!, config);
    if (probe.available) {
      lastError = undefined;
      return { ...current, lastError: undefined, details: probe.details };
    }
  }

  const candidates = [
    config.codexAppServerUrl,
    config.codexAppServerMode === "auto" ? makeListenUrl(config) : undefined,
  ].filter((url): url is string => !!url);

  for (const candidate of candidates) {
    try {
      const probe = await probeUrl(candidate, config);
      if (probe.available) {
        lastError = undefined;
        return {
          available: true,
          url: candidate,
          listenUrl: candidate,
          transport: candidate.startsWith("ws") ? "ws" : "http",
          startedByVibeCodex: false,
          mode: config.codexAppServerMode,
          logDir: config.codexAppServerLogDir,
          details: probe.details,
        };
      }
      lastError = probe.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    available: false,
    url: candidates[0],
    listenUrl: candidates[0],
    transport: config.codexAppServerTransport,
    startedByVibeCodex: false,
    mode: config.codexAppServerMode,
    lastError,
    logDir: config.codexAppServerLogDir,
    details: fallbackDetails(),
  };
}

export async function ensureCodexAppServer(config: Config): Promise<CodexAppServerStatus> {
  const detected = await detectManagedCodexAppServer(config);
  if (detected.available) return detected;
  if (config.codexAppServerMode !== "auto" || !config.codexAppServerAutostart) return detected;
  return startManagedCodexAppServer(config);
}

export async function startManagedCodexAppServer(config: Config): Promise<CodexAppServerStatus> {
  const key = JSON.stringify([config.codexAppServerMode, config.codexAppServerUrl, config.codexAppServerHost, config.codexAppServerPort, config.codexAppServerTransport, config.codexBin]);
  if (startPending) {
    if (key !== startPendingKey) throw new VibeError("CONFIG_ERROR", "Another Codex app-server startup is already in progress with different settings.");
    return startPending;
  }
  startPendingKey = key;
  startPending = startManagedCodexAppServerOnce(config);
  try { return await startPending; }
  finally { startPending = undefined; startPendingKey = undefined; }
}

async function startManagedCodexAppServerOnce(config: Config): Promise<CodexAppServerStatus> {
  if (config.codexAppServerMode === "disabled") {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "CODEX_APP_SERVER_MODE=disabled.", fallbackDetails());
  }
  const detected = await detectManagedCodexAppServer(config);
  if (detected.available) return detected;
  if (config.codexAppServerMode === "manual") {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "CODEX_APP_SERVER_MODE=manual and no configured app-server is healthy.", fallbackDetails({ configuredUrl: config.codexAppServerUrl }));
  }

  if (managed && !hasProcessExited(managed.child)) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "A managed Codex process is running but not ready; stop or restart it before launching another.", fallbackDetails());
  const listenUrl = makeListenUrl(config);
  const apiUrl = apiUrlFromListenUrl(listenUrl);
  const logDir = config.codexAppServerLogDir;
  await fsp.mkdir(logDir, { recursive: true });
  const stdoutLog = fs.createWriteStream(path.join(logDir, "stdout.log"), { flags: "a" });
  const stderrLog = fs.createWriteStream(path.join(logDir, "stderr.log"), { flags: "a" });
  const appServerArgs = [
    "app-server",
    ...(config.codexAppServerIsolateMcpServers ? ["-c", "mcp_servers={}"] : []),
    "--listen",
    listenUrl,
  ];
  const child = spawn(config.codexBin, appServerArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: process.env,
  });

  managed = { child, url: apiUrl, listenUrl, logDir, startedAt: new Date().toISOString() };
  child.stdout.on("data", (chunk: Buffer) => stdoutLog.write(redact(config, chunk.toString("utf8"))));
  child.stderr.on("data", (chunk: Buffer) => stderrLog.write(redact(config, chunk.toString("utf8"))));
  stdoutLog.on("error", (error) => { lastError = redact(config, error.message); });
  stderrLog.on("error", (error) => { lastError = redact(config, error.message); });
  child.on("error", (error) => {
    lastError = redact(config, error.message);
    stdoutLog.end(); stderrLog.end();
    if (managed?.child === child) managed = undefined;
  });
  child.on("exit", (code, signal) => {
    lastError = `app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`;
    stdoutLog.end();
    stderrLog.end();
    if (managed?.child === child) managed = undefined;
  });

  let readiness: Record<string, unknown> | undefined;
  try {
    readiness = (await waitForHealthy(apiUrl, config, child)).details;
    lastError = undefined;
  } catch (error) {
    await terminateProcess(child, 2_000, process.platform !== "win32");
    if (managed?.child === child && hasProcessExited(child)) managed = undefined;
    const logs = await startupLogDetails(config, logDir);
    if (error instanceof VibeError) {
      throw new VibeError(error.code, error.message, {
        ...error.details,
        ...logs,
        command: `${config.codexBin} ${appServerArgs.join(" ")}`,
        isolatedMcpServers: config.codexAppServerIsolateMcpServers,
      });
    }
    throw error;
  }

  return {
    available: true,
    url: listenUrl,
    listenUrl,
    transport: config.codexAppServerTransport,
    pid: child.pid,
    startedByVibeCodex: true,
    mode: config.codexAppServerMode,
    logDir,
    details: {
      ...readiness,
      isolatedMcpServers: config.codexAppServerIsolateMcpServers,
      command: `${config.codexBin} ${appServerArgs.join(" ")}`,
    },
  };
}

export async function stopManagedCodexAppServer(config: Config): Promise<CodexAppServerStatus> {
  if (startPending) await startPending.catch(() => undefined);
  const current = currentManagedStatus(config);
  if (!current || !managed) {
    return { available: false, transport: config.codexAppServerTransport, startedByVibeCodex: false, mode: config.codexAppServerMode, lastError: "No Vibe Codex-managed app-server process is running.", logDir: config.codexAppServerLogDir, details: fallbackDetails() };
  }
  const child = managed.child;
  await terminateProcess(child, 2_000, process.platform !== "win32");
  if (!hasProcessExited(child)) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Managed app-server did not exit after SIGKILL.", fallbackDetails());
  if (managed?.child === child) managed = undefined;
  return { available: false, transport: config.codexAppServerTransport, startedByVibeCodex: true, mode: config.codexAppServerMode, lastError: "Stopped by Vibe Codex.", logDir: config.codexAppServerLogDir, details: fallbackDetails() };
}

export async function restartManagedCodexAppServer(config: Config): Promise<CodexAppServerStatus> {
  await stopManagedCodexAppServer(config);
  return startManagedCodexAppServer(config);
}

export function configWithManagedAppServerUrl(config: Config, status: CodexAppServerStatus): Config {
  if (!status.available || !status.url) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server is unavailable.", fallbackDetails({ status }));
  }
  return { ...config, codexAppServerUrl: status.url };
}
