import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "../config/types.js";
import { RunStore } from "../runs/runStore.js";
import { registerTools } from "../tools/registerTools.js";
import { ApprovalStore } from "../approvals/actionPolicy.js";
import { AuthSessionStore } from "./authSessions.js";

export interface ServerStores {
  approvals: ApprovalStore;
  authSessions: AuthSessionStore;
}

export function createMcpServer(config: Config, runStore: RunStore, stores: ServerStores): McpServer {
  const server = new McpServer({ name: "vibe-codex", version: "0.3.0" });
  registerTools(server, config, runStore, stores);
  return server;
}
