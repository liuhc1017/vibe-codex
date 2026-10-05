import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config/types.js";

export async function tempConfig(): Promise<{ config: Config; root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-codex-test-"));
  const config: Config = {
    port: 8787,
    controlPort: 8788,
    ownerDataDir: path.join(root, ".vibe-codex", "owner"),
    relayToken: "test",
    allowUrlTokenAuth: false,
    urlToken: undefined,
    urlTokenRequiredPrefix: "vibe_",
    urlTokenMinLength: 32,
    urlTokenExpiresAt: undefined,
    disableAuth: true,
    developmentMode: true,
    allowedRoots: [root],
    defaultParentDir: root,
    publicBaseUrl: undefined,
    codexBin: "codex",
    terminalApp: "ghostty",
    terminalFallbackApp: "Terminal",
    preferGhostty: true,
    defaultVisibleMode: "codex-app-visible",
    codexAppServerMode: "manual",
    codexAppServerUrl: undefined,
    codexAppServerPort: 8765,
    codexAppServerHost: "127.0.0.1",
    codexAppServerTransport: "ws",
    codexAppServerAutostart: true,
    codexAppServerLogDir: path.join(root, ".vibe-codex", "app-server"),
    codexAppServerAllowPublicHost: false,
    codexAppServerIsolateMcpServers: true,
    databasePath: path.join(root, "test.sqlite"),
    defaultCodexApproval: "on-request",
    defaultCodexSandbox: "workspace-write",
    allowNetworkCommands: false,
    maxCommandOutputBytes: 200_000,
    commandTimeoutMs: 120_000,
    codexTimeoutMs: 900_000,
    requireApprovalForCodexVisible: false,
    requireApprovalForCodexHidden: true,
    requireApprovalForWriteFile: false,
    requireApprovalForNormalCommands: false,
    enableExperimentalOAuth: false,
    oauthIssuerBaseUrl: undefined,
    oauthAccessTokenTtlSeconds: 3600,
    oauthAuthCodeTtlSeconds: 300,
    oauthAllowedRedirectHosts: ["chat.openai.com", "chatgpt.com"],
    oauthRequireLocalApproval: true,
  };
  return { config, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
