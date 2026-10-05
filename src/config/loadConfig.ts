import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { CodexAppServerMode, CodexAppServerTransport, Config, DefaultVisibleMode } from "./types.js";
import { VibeError } from "../util/errors.js";

dotenv.config();

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitPaths(value: string | undefined, fallback: string[]): string[] {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return (parts.length ? parts : fallback).map((part) => path.resolve(expandHome(part)));
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function defaultVisibleMode(value: string | undefined): DefaultVisibleMode {
  if (value === "codex-app-visible" || value === "ghostty-visible") return value;
  if (value) {
    throw new VibeError("CONFIG_ERROR", "DEFAULT_VISIBLE_MODE must be codex-app-visible or ghostty-visible.", { configured: value });
  }
  return "codex-app-visible";
}

function codexAppServerMode(value: string | undefined): CodexAppServerMode {
  if (value === "disabled" || value === "manual" || value === "auto") return value;
  if (value) throw new VibeError("CONFIG_ERROR", "CODEX_APP_SERVER_MODE must be disabled, manual, or auto.", { configured: value });
  return "auto";
}

function codexAppServerTransport(value: string | undefined): CodexAppServerTransport {
  if (value === "ws" || value === "http") return value;
  if (value) throw new VibeError("CONFIG_ERROR", "CODEX_APP_SERVER_TRANSPORT must be ws or http.", { configured: value });
  return "ws";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const developmentMode = bool(env.VIBE_CODEX_DEV, env.NODE_ENV === "development" || env.NODE_ENV === "test");
  const disableAuth = bool(env.DISABLE_AUTH, false);
  const relayToken = env.RELAY_TOKEN;
  const allowUrlTokenAuth = bool(env.ALLOW_URL_TOKEN_AUTH, false);
  const urlToken = env.URL_TOKEN;
  const urlTokenRequiredPrefix = env.URL_TOKEN_REQUIRED_PREFIX ?? "vibe_";
  const urlTokenMinLength = int(env.URL_TOKEN_MIN_LENGTH, 32);
  const urlTokenExpiresAt = env.URL_TOKEN_EXPIRES_AT || undefined;
  const enableExperimentalOAuth = bool(env.ENABLE_EXPERIMENTAL_OAUTH, false);

  if (!relayToken && !developmentMode && !disableAuth && !enableExperimentalOAuth && !allowUrlTokenAuth) {
    throw new VibeError("CONFIG_ERROR", "Configure OAuth, RELAY_TOKEN, or URL-token authentication before starting Vibe Codex.");
  }
  if (disableAuth && !developmentMode) {
    throw new VibeError("CONFIG_ERROR", "DISABLE_AUTH is only allowed when VIBE_CODEX_DEV=true or NODE_ENV=test.");
  }
  if (allowUrlTokenAuth) {
    if (!urlToken) {
      throw new VibeError("CONFIG_ERROR", "URL_TOKEN is required when ALLOW_URL_TOKEN_AUTH=true.");
    }
    if (urlToken.length < urlTokenMinLength) {
      throw new VibeError("CONFIG_ERROR", "URL_TOKEN is shorter than URL_TOKEN_MIN_LENGTH.", { minLength: urlTokenMinLength });
    }
    if (urlTokenRequiredPrefix && !urlToken.startsWith(urlTokenRequiredPrefix)) {
      throw new VibeError("CONFIG_ERROR", "URL_TOKEN does not match URL_TOKEN_REQUIRED_PREFIX.", { requiredPrefix: urlTokenRequiredPrefix });
    }
    if (urlTokenExpiresAt && Number.isNaN(Date.parse(urlTokenExpiresAt))) {
      throw new VibeError("CONFIG_ERROR", "URL_TOKEN_EXPIRES_AT must be an ISO timestamp.");
    }
  }

  const allowedRoots = splitPaths(env.ALLOWED_ROOTS, [path.resolve(process.cwd())]);
  const defaultParentDir = path.resolve(expandHome(env.DEFAULT_PARENT_DIR ?? allowedRoots[0] ?? process.cwd()));
  const appServerHost = env.CODEX_APP_SERVER_HOST || "127.0.0.1";

  const port = env.PORT?.trim() ? Number(env.PORT) : 8787;
  const controlPort = env.CONTROL_PORT?.trim() ? Number(env.CONTROL_PORT) : port === 8788 ? 8789 : 8788;
  if (!Number.isInteger(port) || !Number.isInteger(controlPort) || port < 1 || port > 65535 || controlPort < 1 || controlPort > 65535 || port === controlPort) {
    throw new VibeError("CONFIG_ERROR", "PORT and CONTROL_PORT must be distinct ports between 1 and 65535.");
  }

  return {
    port,
    controlPort,
    ownerDataDir: path.resolve(expandHome(env.OWNER_DATA_DIR ?? ".vibe-codex/owner")),
    relayToken: relayToken || (developmentMode && !enableExperimentalOAuth ? `vibe_dev_${randomBytes(24).toString("hex")}` : undefined),
    allowUrlTokenAuth,
    urlToken,
    urlTokenRequiredPrefix,
    urlTokenMinLength,
    urlTokenExpiresAt,
    disableAuth,
    developmentMode,
    allowedRoots,
    defaultParentDir,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    codexBin: env.CODEX_BIN || "codex",
    codexModel: env.CODEX_MODEL?.trim() || undefined,
    terminalApp: env.TERMINAL_APP || "ghostty",
    terminalFallbackApp: env.TERMINAL_FALLBACK_APP || "Terminal",
    preferGhostty: bool(env.PREFER_GHOSTTY, true),
    defaultVisibleMode: defaultVisibleMode(env.DEFAULT_VISIBLE_MODE),
    codexAppServerMode: codexAppServerMode(env.CODEX_APP_SERVER_MODE),
    codexAppServerUrl: env.CODEX_APP_SERVER_URL || undefined,
    codexAppServerPort: int(env.CODEX_APP_SERVER_PORT, 8765),
    codexAppServerHost: appServerHost,
    codexAppServerTransport: codexAppServerTransport(env.CODEX_APP_SERVER_TRANSPORT),
    codexAppServerAutostart: bool(env.CODEX_APP_SERVER_AUTOSTART, true),
    codexAppServerLogDir: path.resolve(expandHome(env.CODEX_APP_SERVER_LOG_DIR ?? ".vibe-codex/app-server")),
    codexAppServerAllowPublicHost: bool(env.CODEX_APP_SERVER_ALLOW_PUBLIC_HOST, false),
    codexAppServerIsolateMcpServers: bool(env.CODEX_APP_SERVER_ISOLATE_MCP_SERVERS, true),
    databasePath: path.resolve(env.DATABASE_PATH ?? "./vibe-codex.sqlite"),
    defaultCodexApproval: env.DEFAULT_CODEX_APPROVAL || "untrusted",
    defaultCodexSandbox: env.DEFAULT_CODEX_SANDBOX || "workspace-write",
    allowNetworkCommands: bool(env.ALLOW_NETWORK_COMMANDS, false),
    maxCommandOutputBytes: int(env.MAX_COMMAND_OUTPUT_BYTES, 200_000),
    commandTimeoutMs: int(env.COMMAND_TIMEOUT_MS, 120_000),
    codexTimeoutMs: int(env.CODEX_TIMEOUT_MS, 900_000),
    requireApprovalForCodexVisible: bool(env.REQUIRE_APPROVAL_FOR_CODEX_VISIBLE, false),
    requireApprovalForCodexHidden: bool(env.REQUIRE_APPROVAL_FOR_CODEX_HIDDEN, true),
    requireApprovalForWriteFile: bool(env.REQUIRE_APPROVAL_FOR_WRITE_FILE, false),
    requireApprovalForNormalCommands: bool(env.REQUIRE_APPROVAL_FOR_NORMAL_COMMANDS, false),
    enableExperimentalOAuth,
    oauthIssuerBaseUrl: env.OAUTH_ISSUER_BASE_URL || undefined,
    oauthAccessTokenTtlSeconds: int(env.OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3600),
    oauthAuthCodeTtlSeconds: int(env.OAUTH_AUTH_CODE_TTL_SECONDS, 300),
    oauthAllowedRedirectHosts: (env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "chat.openai.com,chatgpt.com").split(",").map((host) => host.trim()).filter(Boolean),
    oauthRequireLocalApproval: bool(env.OAUTH_REQUIRE_LOCAL_APPROVAL, true),
  };
}
