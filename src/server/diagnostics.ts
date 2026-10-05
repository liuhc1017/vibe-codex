import fs from "node:fs/promises";
import { Config } from "../config/types.js";
import { getCodexVersion } from "../codex/codexCli.js";
import { detectManagedCodexAppServer } from "../codex/codexAppServerManager.js";
import { runProcessArgv } from "../util/spawn.js";
import { authWarnings, buildConnectorUrl } from "../util/connector.js";

export function connectorSettings(config: Config) {
  const base = config.publicBaseUrl?.replace(/\/+$/, "");
  const authentication = config.enableExperimentalOAuth ? "OAuth" : config.allowUrlTokenAuth ? "No auth with URL token" : "Bearer";
  return {
    authentication,
    mcpUrl: base ? config.enableExperimentalOAuth || !config.allowUrlTokenAuth ? `${base}/mcp` : buildConnectorUrl({ baseUrl: base }) : undefined,
    oauthEnabled: config.enableExperimentalOAuth,
    urlTokenAuthEnabled: config.allowUrlTokenAuth,
    tokenRedacted: config.allowUrlTokenAuth && !config.enableExperimentalOAuth,
    publicBaseUrl: base,
    instructions: config.enableExperimentalOAuth
      ? "Add this MCP URL in ChatGPT Developer Mode with OAuth. Approve the connection in this local page."
      : config.allowUrlTokenAuth
        ? "URL-token mode is a development fallback. The real connector URL is a credential; obtain it with npm run pair."
        : "This client must support a static Authorization header. For ChatGPT web, enable OAuth and set PUBLIC_BASE_URL.",
  };
}

export async function collectDiagnostics(config: Config) {
  const [version, appServer, roots, login] = await Promise.all([
    getCodexVersion(config),
    detectManagedCodexAppServer(config),
    Promise.all(config.allowedRoots.map(async (root) => {
      const exists = await fs.stat(root).then((stat) => stat.isDirectory()).catch(() => false);
      return { path: root, exists };
    })),
    runProcessArgv({ file: config.codexBin, args: ["login", "status"], timeoutMs: 5_000, maxOutputBytes: 4_000 }),
  ]);
  const loggedIn = login.exitCode === 0;
  const runnerReady = appServer.available || config.codexAppServerMode === "auto" && config.codexAppServerAutostart;
  const checks = [
    { name: "Codex installed", ok: !!version, detail: version ?? `Install Codex and ensure ${config.codexBin} is on PATH.` },
    { name: "Codex signed in", ok: loggedIn, detail: loggedIn ? "Local Codex authentication is available." : "Run codex login in a terminal, then check again." },
    { name: "Local task runner", ok: runnerReady, detail: appServer.available ? "Codex app-server is available. A model turn has not been tested by this check." : runnerReady ? "A managed Codex app-server will start when you send the first task." : config.codexAppServerMode === "disabled" ? "Task execution is disabled. Set CODEX_APP_SERVER_MODE=auto to enable the managed runner." : "Configure a healthy CODEX_APP_SERVER_URL or enable auto mode and autostart." },
    { name: "Allowed folders", ok: roots.some((root) => root.exists), detail: roots.some((root) => root.exists) ? "Only projects inside these folders can be registered." : "Set ALLOWED_ROOTS to an existing local projects folder." },
    { name: "ChatGPT connector", ok: !!config.publicBaseUrl && config.enableExperimentalOAuth, detail: config.publicBaseUrl && config.enableExperimentalOAuth ? "OAuth connector URL is configured. Tunnel reachability is not checked here." : "Set PUBLIC_BASE_URL to your HTTPS tunnel and ENABLE_EXPERIMENTAL_OAUTH=true for ChatGPT web." },
  ];
  return {
    version: "0.3.0",
    status: checks.every((check) => check.ok) ? "ready" : "needs_setup",
    checks,
    codex: { available: !!version, version, loggedIn, appServer, executionReady: !!version && loggedIn && runnerReady && roots.some((root) => root.exists), note: "Process/login checks are prerequisites, not proof of a successful model turn." },
    roots,
    connector: connectorSettings(config),
    warnings: authWarnings(config),
    localControlUrl: `http://127.0.0.1:${config.controlPort}`,
  };
}
