import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import { createServer as createNodeHttpServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createMcpServer } from "../src/server/mcpServer.js";
import { createHttpApp } from "../src/server/http.js";
import { initRunStore } from "../src/runs/runStore.js";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";
import { AuthSessionStore } from "../src/server/authSessions.js";
import { tempConfig } from "../tests/helpers.js";
import { runProcessArgv } from "../src/util/spawn.js";
import { getRunCoordinator } from "../src/codex/runCoordinator.js";

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function parseMcpResponse(text: string): any {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

async function createFakeWsAppServer(threadId = "verify-thread-1") {
  const requests: Array<{ method?: string; params?: any }> = [];
  const httpServer = createNodeHttpServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404).end();
  });
  const wsServer = new WebSocketServer({ server: httpServer });
  let cwd = "";
  let count = 0;
  const history: any[] = [];
  const timers = new Set<NodeJS.Timeout>();
  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      if (!request.id) return;
      requests.push({ method: request.method, params: request.params });
      const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      if (request.method === "initialize") return respond({ protocolVersion: "0.1", serverInfo: { name: "fake-codex-app-server" } });
      if (request.method === "thread/list") return respond({ threads: [{ id: threadId, title: "Verify Thread" }] });
      if (request.method === "thread/start") {
        cwd = request.params.cwd;
        return respond({ thread: { id: threadId, cwd, turns: [], status: { type: "idle" } } });
      }
      if (request.method === "thread/resume" || request.method === "thread/read") return respond({ thread: { id: request.params.threadId, cwd, turns: history, status: { type: "idle" } } });
      if (request.method === "turn/start") {
        const turn: any = { id: `turn-${++count}`, status: "inProgress", items: [] };
        history.push(turn);
        respond({ turn });
        const timer = setTimeout(() => {
          timers.delete(timer);
          Object.assign(turn, { status: "completed", items: [{ id: `answer-${count}`, type: "agentMessage", phase: "final_answer", text: `Verified final answer ${count}` }] });
          socket.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn } }));
        }, 50);
        timers.add(timer);
        return;
      }
      return socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of wsServer.clients) socket.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => httpServer.close(() => resolve())));
    },
  };
}

async function mcpSmoke() {
  const ctx = await tempConfig();
  ctx.config.disableAuth = false;
  ctx.config.relayToken = "verify-token";
  ctx.config.codexAppServerMode = "manual";
  ctx.config.enableExperimentalOAuth = true;
  const store = initRunStore(ctx.config.databasePath);
  const fakeAppServer = await createFakeWsAppServer();
  ctx.config.codexAppServerUrl = fakeAppServer.url;
  const stores = { approvals: new ApprovalStore(), authSessions: new AuthSessionStore() };
  const app = createHttpApp(ctx.config, () => createMcpServer(ctx.config, store, stores), stores.authSessions);
  const httpServer = app.listen(0);
  try {
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    ctx.config.publicBaseUrl = baseUrl;
    ctx.config.oauthIssuerBaseUrl = baseUrl;

    const protectedResource = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json() as any;
    const authServer = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json() as any;
    if (protectedResource.resource !== `${baseUrl}/mcp`) throw new Error("OAuth protected-resource metadata has unexpected resource");
    if (authServer.authorization_endpoint !== `${baseUrl}/authorize`) throw new Error("OAuth authorization metadata has unexpected authorize endpoint");
    if (!authServer.scopes_supported?.includes("mcp")) throw new Error("OAuth metadata does not advertise mcp scope");

    const headers = {
      authorization: `Bearer ${ctx.config.relayToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const post = async (body: unknown, sessionId?: string) => fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify(body),
    });

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vibe-verify", version: "0" } },
    });
    const sessionId = init.headers.get("mcp-session-id");
    if (!init.ok || !sessionId) throw new Error(`MCP initialize failed: ${init.status} ${await init.text()}`);
    await (await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId)).text();

    const tools = parseMcpResponse(await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId)).text());
    const toolNames = new Set<string>(tools.result.tools.map((tool: any) => tool.name));
    for (const name of ["relay_health", "connector_setup_status", "register_project", "start_project_task", "send_codex_app_thread_message", "get_codex_app_server_status"]) {
      if (!toolNames.has(name)) throw new Error(`Missing tool in verify smoke: ${name}`);
    }

    const resources = parseMcpResponse(await (await post({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }, sessionId)).text());
    const resourceUris = new Set<string>(resources.result.resources.map((resource: any) => resource.uri));
    for (const uri of ["vibe://status", "vibe://operator-guide", "vibe://feature-matrix", "vibe://setup"]) {
      if (!resourceUris.has(uri)) throw new Error(`Missing resource in verify smoke: ${uri}`);
    }

    const health = parseMcpResponse(await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "relay_health", arguments: {} } }, sessionId)).text());
    if (!["ok", "degraded"].includes(health.result.structuredContent.status)) throw new Error("relay_health returned an unexpected status");

    const appServer = parseMcpResponse(await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_codex_app_server_status", arguments: {} } }, sessionId)).text());
    if (appServer.result.structuredContent.available !== true) throw new Error("get_codex_app_server_status did not detect the fake app-server");

    const workspace = path.join(ctx.root, "verify-project");
    await fs.mkdir(workspace);
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    // Fixture setup represents a local owner granting project access.
    store.createProject({ name: "verify-project", path: await fs.realpath(workspace), preferredExecutionMode: "codex-app-thread" });
    const registered = parseMcpResponse(await (await post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "register_project", arguments: { name: "verify-project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
    }, sessionId)).text());
    if (registered.result.structuredContent.createdWorkspace !== false) throw new Error("register_project should reuse the existing workspace");

    const appThread = parseMcpResponse(await (await post({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "start_codex_app_thread", arguments: { workspacePath: workspace, userGoal: "Verify no-paste app-thread smoke." } },
    }, sessionId)).text());
    const appThreadResult = appThread.result.structuredContent;
    if (appThreadResult.promptSubmittedAutomatically !== true || appThreadResult.requiresManualPaste !== false || appThreadResult.usesCodexExec !== false || appThreadResult.usesShellScript !== false) {
      throw new Error("start_codex_app_thread returned incorrect no-paste mode flags");
    }
    if (!fakeAppServer.requests.some((request) => request.method === "turn/start" && request.params?.input?.[0]?.text?.includes("Verify no-paste app-thread smoke."))) {
      throw new Error("Fake app-server did not receive the app-thread turn/start prompt");
    }

    const call = async (id: number, name: string, args: unknown) => {
      const response = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sessionId);
      const payload = parseMcpResponse(await response.text());
      if (!response.ok || payload.result.isError) throw new Error(`Smoke tool ${name} failed.`);
      return payload.result.structuredContent;
    };
    const wait = async (runId: string, expected: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { run } = await call(8, "get_run", { runId });
        if (run.status === "completed") {
          if (run.summary !== expected) throw new Error("Final answer was not persisted.");
          return run;
        }
        if (["failed", "recovery_required"].includes(run.status)) throw new Error(`Smoke turn ended ${run.status}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Smoke task did not complete.");
    };
    await wait(appThreadResult.runId, "Verified final answer 1");
    const followup = await call(9, "continue_project_task", { projectRef: "verify-project", instruction: "Verify the same-thread follow-up." });
    if (followup.threadId !== appThreadResult.threadId) throw new Error("Follow-up changed threads.");
    const finished = await wait(followup.runId, "Verified final answer 2");
    if (finished.metadata.parentRunId !== appThreadResult.runId) throw new Error("Follow-up lineage is incorrect.");
    const result = await call(10, "collect_project_result", { runId: finished.id });
    if (result.status !== "completed" || result.finalAnswer !== "Verified final answer 2") throw new Error("Result collection lost the final answer.");
    console.log("verify: local MCP, OAuth discovery, project grant, delayed final answer, same-thread follow-up, lineage, and safe result smoke passed (fake Codex; no real model or ChatGPT UI)");
  } finally {
    await getRunCoordinator(ctx.config, store).close();
    await app.locals.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fakeAppServer.close();
    stores.approvals.close();
    store.db.close();
    await ctx.cleanup();
  }
}

await run("npm", ["run", "build"]);
await run("npm", ["test"]);
await mcpSmoke();
