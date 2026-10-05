import { AddressInfo } from "node:net";
import { createServer as createNodeHttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import fs from "node:fs/promises";
import { getRunCoordinator } from "../src/codex/runCoordinator.js";
import { stopManagedCodexAppServer } from "../src/codex/codexAppServerManager.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcpServer.js";
import { createHttpApp } from "../src/server/http.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";
import { AuthSessionStore } from "../src/server/authSessions.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let store: RunStore;
let baseUrl: string;
let httpServer: ReturnType<ReturnType<typeof createHttpApp>["listen"]>;
let app: ReturnType<typeof createHttpApp>;
let approvals: ApprovalStore;

function parseMcpResponse(text: string): any {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

async function postMcp(body: unknown, sessionId?: string, options?: { path?: string; bearer?: boolean }) {
  const useBearer = options?.bearer ?? true;
  return fetch(`${baseUrl}${options?.path ?? "/mcp"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(useBearer ? { authorization: `Bearer ${ctx.config.relayToken}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function initialize() {
  const response = await postMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vibe-codex-test", version: "0.0.0" },
    },
  });
  const text = await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  return { response, text, sessionId, payload: parseMcpResponse(text) };
}

async function callTool(sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const response = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sessionId);
  expect(response.status).toBe(200);
  return parseMcpResponse(await response.text()).result;
}

async function ownerGrantWorkspace(workspace: string, name = workspace.split("/").at(-1)!.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ")) {
  // This is the local owner's grant, not a remote connector approving itself.
  return store.createProject({ name, path: await fs.realpath(workspace), preferredExecutionMode: "codex-app-thread" });
}

async function waitForCompleted(runId: string) {
  await expect.poll(() => store.getRun(runId)?.status, { timeout: 2_000 }).toBe("completed");
}

async function closeFakeServer(server: ReturnType<typeof createNodeHttpServer>, wsServer: WebSocketServer) {
  await getRunCoordinator(ctx.config, store).close();
  for (const socket of wsServer.clients) socket.terminate();
  await new Promise<void>((resolve) => wsServer.close(() => server.close(() => resolve())));
}

function createFakeWsAppServer(args?: { threadId?: string; forkThreadId?: string; autoComplete?: boolean; completionDelayMs?: number }) {
  const requests: Array<{ method?: string; params?: any }> = [];
  const threadId = args?.threadId ?? "thread-1";
  const forkThreadId = args?.forkThreadId ?? "thread-2";
  const threads = new Map<string, { id: string; cwd: string; turns: any[] }>();
  const active = new Map<string, { socket: WebSocket; turn: any }>();
  const timers = new Set<NodeJS.Timeout>();
  let starts = 0;
  let turns = 0;
  const httpServer = createNodeHttpServer((req, res) => {
    if (req.method === "GET" && ["/healthz", "/readyz", "/health"].includes(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404).end();
  });
  const wsServer = new WebSocketServer({ server: httpServer });
  const send = (socket: WebSocket, message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const complete = (id: string, answer = "Fake Codex finished.", status = "completed") => {
    const current = active.get(id);
    if (!current) throw new Error(`No active fake turn for ${id}`);
    const item = { id: `answer-${current.turn.id}`, type: "agentMessage", phase: "final_answer", text: answer };
    send(current.socket, { method: "item/agentMessage/delta", params: { threadId: id, turnId: current.turn.id, itemId: item.id, delta: answer } });
    Object.assign(current.turn, { status, items: [item] });
    send(current.socket, { method: "turn/completed", params: { threadId: id, turn: current.turn } });
    active.delete(id);
  };
  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      if (request.id == null || !request.method) return;
      requests.push({ method: request.method, params: request.params });
      const respond = (result: unknown) => send(socket, { jsonrpc: "2.0", id: request.id, result });
      if (request.method === "initialize") return respond({ protocolVersion: "0.1", serverInfo: { name: "fake-codex-app-server" } });
      if (request.method === "thread/list") return respond({ threads: [...threads.values()] });
      if (request.method === "thread/start") {
        const id = ++starts === 1 ? threadId : `${threadId}-${starts}`;
        const thread = { id, cwd: request.params.cwd, turns: [] };
        threads.set(id, thread);
        return respond({ thread: { ...thread, status: { type: "idle" } } });
      }
      if (request.method === "thread/resume" || request.method === "thread/read") {
        const thread = threads.get(request.params.threadId);
        if (!thread) return send(socket, { id: request.id, error: { code: -32000, message: "Unknown thread" } });
        return respond({ thread: { ...thread, turns: request.method === "thread/read" && !request.params.includeTurns ? [] : thread.turns,
          status: { type: active.has(thread.id) ? "active" : "idle", ...(active.has(thread.id) ? { activeFlags: [] } : {}) } } });
      }
      if (request.method === "thread/fork") {
        const source = threads.get(request.params.threadId)!;
        const thread = { id: forkThreadId, cwd: source.cwd, turns: structuredClone(source.turns) };
        threads.set(thread.id, thread);
        return respond({ thread: { ...thread, status: { type: "idle" } } });
      }
      if (request.method === "turn/start") {
        const id = request.params.threadId;
        const turn = { id: `turn-${++turns}`, status: "inProgress", items: [] };
        threads.get(id)!.turns.push(turn);
        active.set(id, { socket, turn });
        respond({ turn });
        if (args?.autoComplete !== false) {
          const timer = setTimeout(() => { timers.delete(timer); if (active.has(id)) complete(id); }, args?.completionDelayMs ?? 40);
          timers.add(timer);
        }
        return;
      }
      if (request.method === "turn/interrupt") { respond({}); return complete(request.params.threadId, "Stopped.", "interrupted"); }
      send(socket, { id: request.id, error: { code: -32601, message: "Method not found" } });
    });
  });
  return { httpServer, requests, threads, active, complete,
    close: async () => { for (const timer of timers) clearTimeout(timer); await closeFakeServer(httpServer, wsServer); },
  };
}

beforeEach(async () => {
  ctx = await tempConfig();
  ctx.config.developmentMode = true;
  ctx.config.disableAuth = false;
  ctx.config.relayToken = "test-token";
  store = initRunStore(ctx.config.databasePath);
  approvals = new ApprovalStore();
  const stores = { approvals, authSessions: new AuthSessionStore() };
  app = createHttpApp(ctx.config, () => createMcpServer(ctx.config, store, stores), stores.authSessions);
  httpServer = app.listen(0);
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await getRunCoordinator(ctx.config, store).close();
  await app.locals.dispose();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  if (ctx.config.codexAppServerMode === "auto") await stopManagedCodexAppServer(ctx.config);
  approvals.close();
  store.db.close();
  await ctx.cleanup();
});

describe("MCP Streamable HTTP sessions", () => {
  it("requires a local owner grant even when a remote caller requests registration and approval", async () => {
    const workspace = `${ctx.root}/owner-granted-project`;
    await fs.mkdir(workspace);
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    const init = await initialize();
    const args = { name: "Owner Granted Project", workspacePath: workspace };
    const requested = (await callTool(init.sessionId!, "register_project", args)).structuredContent;
    expect(requested.approvalRequired).toBe(true);
    expect(store.listProjects()).toHaveLength(0);

    const remoteApproval = await callTool(init.sessionId!, "approve_action", { approvalId: requested.approvalId });
    expect(remoteApproval.structuredContent.approvalRequired).toBe(true);
    expect(approvals.list("approved")).toHaveLength(0);
    expect((await callTool(init.sessionId!, "register_project", args)).structuredContent.approvalId).toBe(requested.approvalId);
    expect((await callTool(init.sessionId!, "read_file", { workspacePath: workspace, relativePath: "README.md" })).isError).toBe(true);
    expect((await callTool(init.sessionId!, "write_file", { workspacePath: workspace, relativePath: "README.md", content: "unapproved" })).isError).toBe(true);
    expect(await fs.readdir(workspace)).toEqual([".git"]);

    approvals.approve(requested.approvalId);
    const registered = (await callTool(init.sessionId!, "register_project", args)).structuredContent;
    expect(registered.project.path).toBe(await fs.realpath(workspace));
    expect(approvals.list("consumed")).toHaveLength(1);
    expect(store.listProjects()).toHaveLength(1);
  });

  it("binds a one-use local write approval to exact content", async () => {
    ctx.config.requireApprovalForWriteFile = true;
    const workspace = `${ctx.root}/exact-write`;
    await fs.mkdir(workspace);
    await ownerGrantWorkspace(workspace);
    const init = await initialize();
    const args = { workspacePath: workspace, relativePath: "result.txt", content: "approved content" };
    const requested = (await callTool(init.sessionId!, "write_file", args)).structuredContent;
    expect(requested.approvalRequired).toBe(true);
    await callTool(init.sessionId!, "approve_action", { approvalId: requested.approvalId });
    expect(approvals.list("approved")).toHaveLength(0);
    approvals.approve(requested.approvalId);

    const changed = (await callTool(init.sessionId!, "write_file", { ...args, content: "different content" })).structuredContent;
    expect(changed.approvalRequired).toBe(true);
    expect(changed.approvalId).not.toBe(requested.approvalId);
    expect(await fs.readdir(workspace)).toEqual([]);
    expect((await callTool(init.sessionId!, "write_file", args)).structuredContent.directWrite).toBe(true);
    expect(await fs.readFile(`${workspace}/result.txt`, "utf8")).toBe("approved content");
    const replay = (await callTool(init.sessionId!, "write_file", args)).structuredContent;
    expect(replay.approvalRequired).toBe(true);
    expect(replay.approvalId).not.toBe(requested.approvalId);
  });

  it("filters stale, removed, and ungranted records from every connector listing", async () => {
    const allowedRoot = `${ctx.root}/allowed`;
    const workspace = `${allowedRoot}/current`;
    const removedPath = `${allowedRoot}/removed`;
    const ungrantedPath = `${allowedRoot}/discovered-only`;
    const revokedPath = `${ctx.root}/revoked`;
    for (const directory of [workspace, removedPath, ungrantedPath, revokedPath]) await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(`${ungrantedPath}/.git`);
    const allowed = await ownerGrantWorkspace(workspace);
    const removed = await ownerGrantWorkspace(removedPath);
    const revoked = await ownerGrantWorkspace(revokedPath);
    const seedRun = (workspacePath: string, threadId: string, projectId?: string) => store.createRun({
      projectId, workspacePath, status: "completed", autonomy: "workspace", prompt: `private ${threadId}`,
      command: "codex-app-thread", stdout: `private output ${threadId}`, metadata: { codexThreadId: threadId },
    });
    const allowedRun = seedRun(allowed.path, "allowed-thread", allowed.id);
    const removedRun = seedRun(removed.path, "removed-thread", removed.id);
    const revokedRun = seedRun(revoked.path, "revoked-thread", revoked.id);
    const ungrantedRun = seedRun(await fs.realpath(ungrantedPath), "ungranted-thread");
    for (const project of [allowed, removed, revoked]) {
      approvals.create({ reason: `write ${project.name}`, actionRisk: "write", actionSummary: { tool: "write_file", workspacePath: project.path } });
    }
    await fs.rename(removedPath, `${allowedRoot}/archived`);
    ctx.config.allowedRoots = [await fs.realpath(allowedRoot)];
    ctx.config.defaultParentDir = ctx.config.allowedRoots[0];
    const init = await initialize();

    expect((await callTool(init.sessionId!, "list_projects")).structuredContent.projects.map((project: any) => project.id)).toEqual([allowed.id]);
    const discovered = (await callTool(init.sessionId!, "list_projects", { includeDiscovered: true })).structuredContent.projects;
    expect(discovered).toEqual(expect.arrayContaining([expect.objectContaining({ path: await fs.realpath(ungrantedPath), registered: false })]));
    expect((await callTool(init.sessionId!, "list_recent_runs")).structuredContent.runs.map((run: any) => run.id)).toEqual([allowedRun.id]);
    expect((await callTool(init.sessionId!, "list_codex_threads")).structuredContent.threads.map((thread: any) => thread.id)).toEqual(["allowed-thread"]);
    const setup = (await callTool(init.sessionId!, "connector_setup_status", { checkPublicReachability: false })).structuredContent;
    expect(setup.recentRuns.map((run: any) => run.id)).toEqual([allowedRun.id]);
    expect(setup.pendingApprovals.map((approval: any) => approval.actionSummary.workspacePath)).toEqual([allowed.path]);
    expect((await callTool(init.sessionId!, "list_pending_approvals")).structuredContent.approvals).toHaveLength(1);
    const statusResponse = await postMcp({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "vibe://status" } }, init.sessionId!);
    const status = JSON.parse(parseMcpResponse(await statusResponse.text()).result.contents[0].text);
    expect(status.projects.map((project: any) => project.id)).toEqual([allowed.id]);
    expect(status.recentRuns.map((run: any) => run.id)).toEqual([allowedRun.id]);
    expect(status.pendingApprovals.map((approval: any) => approval.actionSummary.workspacePath)).toEqual([allowed.path]);
    for (const run of [removedRun, revokedRun, ungrantedRun]) {
      for (const name of ["get_run", "collect_project_result", "collect_visible_run_result"]) {
        const result = await callTool(init.sessionId!, name, { runId: run.id });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(run.stdout);
        expect(JSON.stringify(result)).not.toContain(run.workspacePath);
      }
      expect((await callTool(init.sessionId!, "get_codex_app_thread_status", { threadId: run.metadata!.codexThreadId })).isError).toBe(true);
    }
    for (const project of [removed, revoked]) expect((await callTool(init.sessionId!, "get_project", { projectRef: project.id })).isError).toBe(true);
  });

  it("does not expose old records when their path becomes a symlink to another granted project", async () => {
    const oldPath = `${ctx.root}/old-location`;
    const otherPath = `${ctx.root}/current-location`;
    await fs.mkdir(oldPath);
    await fs.mkdir(otherPath);
    const oldProject = await ownerGrantWorkspace(oldPath);
    const otherProject = await ownerGrantWorkspace(otherPath);
    const oldRun = store.createRun({ projectId: oldProject.id, workspacePath: oldProject.path, status: "completed", autonomy: "workspace", prompt: "private former-project prompt", command: "codex-app-thread", stdout: "private former-project output", metadata: { codexThreadId: "former-project-thread" } });
    await fs.rename(oldPath, `${ctx.root}/archived-location`);
    await fs.symlink(otherProject.path, oldPath, "dir");
    const init = await initialize();
    expect((await callTool(init.sessionId!, "list_projects")).structuredContent.projects.map((project: any) => project.id)).toEqual([otherProject.id]);
    expect((await callTool(init.sessionId!, "list_recent_runs")).structuredContent.runs).toEqual([]);
    expect((await callTool(init.sessionId!, "list_codex_threads")).structuredContent.threads).toEqual([]);
    expect((await callTool(init.sessionId!, "get_project", { projectRef: oldProject.id })).isError).toBe(true);
    const denied = await callTool(init.sessionId!, "get_run", { runId: oldRun.id });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(oldRun.stdout);
  });

  it("only selects default threads already remembered for the same granted workspace", async () => {
    const workspace = `${ctx.root}/thread-owner`;
    const otherWorkspace = `${ctx.root}/other-thread-owner`;
    await fs.mkdir(workspace);
    await fs.mkdir(otherWorkspace);
    const project = await ownerGrantWorkspace(workspace);
    const other = await ownerGrantWorkspace(otherWorkspace);
    for (const [record, threadId] of [[project, "same-workspace-thread"], [other, "other-workspace-thread"]] as const) {
      store.createRun({ projectId: record.id, workspacePath: record.path, status: "completed", autonomy: "workspace", prompt: "done", command: "codex-app-thread", metadata: { codexThreadId: threadId } });
    }
    const init = await initialize();
    for (const codexThreadId of ["unknown-thread", "other-workspace-thread"]) {
      expect((await callTool(init.sessionId!, "set_project_default_thread", { projectRef: project.id, codexThreadId })).isError).toBe(true);
      expect(store.getProject(project.id)!.defaultCodexThreadId).toBeUndefined();
    }
    const selected = await callTool(init.sessionId!, "set_project_default_thread", { projectRef: project.id, codexThreadId: "same-workspace-thread" });
    expect(selected.structuredContent.project.defaultCodexThreadId).toBe("same-workspace-thread");
  });

  it("denies manual autonomy before creating execution approval gates on every entry point", async () => {
    ctx.config.requireApprovalForCodexVisible = true;
    const workspace = `${ctx.root}/manual-project`;
    await fs.mkdir(workspace);
    const project = await ownerGrantWorkspace(workspace);
    const init = await initialize();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["start_codex_task", { workspacePath: workspace, userGoal: "do not run" }],
      ["start_project_task", { projectRef: project.id, userGoal: "do not run" }],
      ["continue_project_task", { projectRef: project.id, instruction: "do not run" }],
      ["start_codex_app_thread", { workspacePath: workspace, userGoal: "do not run" }],
      ["resume_codex_app_thread", { workspacePath: workspace, threadId: "manual-thread", prompt: "do not run" }],
      ["fork_codex_app_thread", { workspacePath: workspace, threadId: "manual-thread", instruction: "do not run" }],
      ["continue_codex_app_thread", { workspacePath: workspace, threadId: "manual-thread", instruction: "do not run" }],
      ["run_codex_app_thread_turn", { workspacePath: workspace, threadId: "manual-thread", task: "do not run" }],
      ["send_codex_app_thread_message", { workspacePath: workspace, threadId: "manual-thread", message: "do not run" }],
      ["continue_codex_task", { runId: "manual-run", instruction: "do not run" }],
    ];
    for (const [name, args] of calls) {
      const result = await callTool(init.sessionId!, name, { ...args, autonomy: "manual" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.message).toContain("Manual autonomy");
    }
    expect(approvals.list()).toHaveLength(0);
    expect(store.listRuns()).toHaveLength(0);
  });

  it("reads a delayed final answer through MCP rather than treating the start acknowledgment as completion", async () => {
    const fake = createFakeWsAppServer({ autoComplete: false });
    await new Promise<void>((resolve) => fake.httpServer.listen(0, resolve));
    try {
      ctx.config.codexAppServerUrl = `ws://127.0.0.1:${(fake.httpServer.address() as AddressInfo).port}`;
      const workspace = `${ctx.root}/delayed-result`;
      await fs.mkdir(workspace);
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
      const project = await ownerGrantWorkspace(workspace);
      const init = await initialize();
      const started = (await callTool(init.sessionId!, "start_project_task", { projectRef: project.id, userGoal: "Report the result" })).structuredContent;
      expect(started.status).toBe("running");
      expect((await callTool(init.sessionId!, "get_run", { runId: started.runId })).structuredContent.run.status).toBe("running");
      fake.complete(started.threadId, "The exact delayed final answer.");
      await waitForCompleted(started.runId);
      const persisted = (await callTool(init.sessionId!, "get_run", { runId: started.runId })).structuredContent.run;
      expect(persisted.status).toBe("completed");
      expect(persisted.stdout).toContain("The exact delayed final answer.");
      const result = (await callTool(init.sessionId!, "collect_project_result", { runId: started.runId })).structuredContent;
      expect(result.status).toBe("completed");
      expect(result.finalAnswer).toBe("The exact delayed final answer.");
    } finally { await fake.close(); }
  });

  it("bearer auth still works on /mcp", async () => {
    const init = await initialize();
    expect(init.response.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });

  it("initialize returns and establishes a session", async () => {
    const init = await initialize();
    expect(init.response.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.payload.result.serverInfo.name).toBe("vibe-codex");
  });

  it("tools/list works after initialize and initialized notification", async () => {
    const init = await initialize();
    expect(init.sessionId).toBeTruthy();

    const initialized = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!);
    expect([200, 202]).toContain(initialized.status);
    await initialized.text();

    const response = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("relay_health");
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("detect_codex_app_server");
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("start_codex_app_thread");
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("run_codex_app_thread_turn");
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("send_codex_app_thread_message");
    const continueThreadTool = payload.result.tools.find((tool: any) => tool.name === "continue_codex_app_thread");
    const sendMessageTool = payload.result.tools.find((tool: any) => tool.name === "send_codex_app_thread_message");
    const startProjectTool = payload.result.tools.find((tool: any) => tool.name === "start_project_task");
    expect(continueThreadTool.description).toContain("raw text");
    expect(continueThreadTool.description).toContain("does not add a Vibe Codex handoff envelope");
    expect(sendMessageTool.description).toContain("plain raw message");
    expect(sendMessageTool.description).toContain("does not add a Vibe Codex handoff envelope");
    expect(startProjectTool.description).toContain("Do not use it to send a plain message");
  });

  it("resources/list and resources/read expose ChatGPT App guidance", async () => {
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

    const listResponse = await postMcp({ jsonrpc: "2.0", id: 200, method: "resources/list", params: {} }, init.sessionId!);
    const listPayload = parseMcpResponse(await listResponse.text());
    expect(listResponse.status).toBe(200);
    const uris = listPayload.result.resources.map((resource: any) => resource.uri);
    expect(uris).toEqual(expect.arrayContaining(["vibe://status", "vibe://operator-guide", "vibe://feature-matrix", "vibe://setup"]));

    const statusResponse = await postMcp({ jsonrpc: "2.0", id: 201, method: "resources/read", params: { uri: "vibe://status" } }, init.sessionId!);
    const statusPayload = parseMcpResponse(await statusResponse.text());
    const status = JSON.parse(statusPayload.result.contents[0].text);
    expect(status.app.name).toBe("Vibe Codex");
    expect(status.authMode).toBe("Bearer");
    expect(status.codexAppServer).toBeTruthy();
    expect(status.connector.publicReachability.checked).toBe(false);

    const guideResponse = await postMcp({ jsonrpc: "2.0", id: 202, method: "resources/read", params: { uri: "vibe://operator-guide" } }, init.sessionId!);
    const guidePayload = parseMcpResponse(await guideResponse.text());
    expect(guidePayload.result.contents[0].text).toContain("send_codex_app_thread_message");
    expect(guidePayload.result.contents[0].text).toContain("Do not create a new workspace");

    const matrixResponse = await postMcp({ jsonrpc: "2.0", id: 203, method: "resources/read", params: { uri: "vibe://feature-matrix" } }, init.sessionId!);
    const matrixPayload = parseMcpResponse(await matrixResponse.text());
    expect(matrixPayload.result.contents[0].text).toContain("| Feature | MCP tools/resources | Status | Auth | Paste mode | Tests | Limits |");
    expect(matrixPayload.result.contents[0].text).toContain("Raw thread messages");

    const setupResponse = await postMcp({ jsonrpc: "2.0", id: 204, method: "resources/read", params: { uri: "vibe://setup" } }, init.sessionId!);
    const setupPayload = parseMcpResponse(await setupResponse.text());
    expect(setupPayload.result.contents[0].text).toContain("ChatGPT Developer Mode");
  });

  it("connector_setup_status can check OAuth public reachability", async () => {
    ctx.config.enableExperimentalOAuth = true;
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

    const response = await postMcp({
      jsonrpc: "2.0",
      id: 205,
      method: "tools/call",
      params: { name: "connector_setup_status", arguments: { baseUrl, checkPublicReachability: true } },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.chatGptDeveloperMode.authentication).toBe("OAuth");
    expect(payload.result.structuredContent.tunnel.reachability).toMatchObject({
      checked: true,
      reachable: true,
      status: 200,
    });
  });

  it("tools/list with an unknown session returns 404 so callers can initialize again", async () => {
    const response = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "missing-session");
    const payload = await response.json();
    expect(response.status).toBe(404);
    expect(payload.error.message).toBe("Invalid or missing MCP session id");
  });

  it("rate limits repeated MCP initialize requests", async () => {
    let response: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      response = await postMcp({
        jsonrpc: "2.0",
        id: 1000 + i,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "rate-limit", version: "0.0.0" },
        },
      });
      await response.text();
    }
    expect(response?.status).toBe(429);
  });

  it("relay_health can be called through MCP", async () => {
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

    const response = await postMcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "relay_health", arguments: {} },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.version).toBe("0.3.0");
    expect(["ok", "degraded"]).toContain(payload.result.structuredContent.status);
  });

  it("/mcp/:urlToken works when enabled and token matches", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_secret_url_token_that_is_long_enough";
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "url-token-test", version: "0.0.0" },
      },
    }, undefined, { path: "/mcp/vibe_secret_url_token_that_is_long_enough", bearer: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("/mcp query token works when enabled and token matches", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_query_secret_that_is_long_enough";
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "query-token-test", version: "0.0.0" },
      },
    }, undefined, { path: "/mcp?vibe_token=vibe_query_secret_that_is_long_enough", bearer: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("/mcp/:urlToken rejects a wrong token without printing it", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_right_token_that_is_long_enough";
    const response = await postMcp({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }, undefined, { path: "/mcp/wrong-token", bearer: false });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain("wrong-token");
    expect(text).not.toContain("right-token");
  });

  it("/mcp/:urlToken rejects when URL token auth is disabled", async () => {
    ctx.config.allowUrlTokenAuth = false;
    ctx.config.urlToken = "vibe_disabled_token_that_is_long_enough";
    const response = await postMcp({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} }, undefined, { path: "/mcp/disabled-token", bearer: false });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain("disabled-token");
  });

  it("/mcp/:urlToken rejects expired URL tokens", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_expired_token_that_is_long_enough";
    ctx.config.urlTokenExpiresAt = "2000-01-01T00:00:00.000Z";
    const response = await postMcp({ jsonrpc: "2.0", id: 14, method: "tools/list", params: {} }, undefined, { path: "/mcp/vibe_expired_token_that_is_long_enough", bearer: false });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain("vibe_expired_token_that_is_long_enough");
  });

  it("hidden Codex requires allowHiddenCodex or approval", async () => {
    const workspace = `${ctx.root}/hidden-codex`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "start_codex_task",
        arguments: {
          workspacePath: workspace,
          userGoal: "Say hello",
          executionMode: "exec-hidden",
        },
      },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.approvalRequired).toBe(true);
    expect(payload.result.structuredContent.approvalId).toBeTruthy();
    expect(payload.result.structuredContent.doNotFallbackToDirectWrite).toBe(true);
  });

  it("start_codex_task defaults to managed execution and approval-gates before launch when required", async () => {
    ctx.config.requireApprovalForCodexVisible = true;
    const workspace = `${ctx.root}/ghostty-default`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "start_codex_task",
        arguments: {
          workspacePath: workspace,
          userGoal: "Prepare an interactive Codex task",
        },
      },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.approvalRequired).toBe(true);
    expect(payload.result.structuredContent.actionSummary.executionMode).toBe("codex-app-thread");
  });

  it("start_codex_task codex-app-visible returns app_visible_ready without codex exec or Ghostty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const binDir = path.join(ctx.root, "bin");
    const codexLog = path.join(ctx.root, "codex-args.log");
    const clipboardLog = path.join(ctx.root, "clipboard.txt");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "codex"), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then printf 'codex-cli test\\n'; exit 0; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(codexLog)}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, "pbcopy"), `#!/usr/bin/env bash\ncat > ${JSON.stringify(clipboardLog)}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, "pbpaste"), `#!/usr/bin/env bash\ncat ${JSON.stringify(clipboardLog)}\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      ctx.config.codexBin = path.join(binDir, "codex");
      const workspace = `${ctx.root}/codex-app-visible`;
      await fs.mkdir(workspace);
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
      const resolvedWorkspace = await fs.realpath(workspace);
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
      const response = await postMcp({
        jsonrpc: "2.0",
        id: 171,
        method: "tools/call",
        params: {
          name: "start_codex_task",
          arguments: {
            workspacePath: workspace,
            userGoal: "Create one GUI-visible file",
            executionMode: "codex-app-visible",
          },
        },
      }, init.sessionId!);
      const payload = parseMcpResponse(await response.text());
      expect(response.status).toBe(200);
      const result = payload.result.structuredContent;
      expect(result.status).toBe("app_visible_ready");
      expect(result.executionMode).toBe("codex-app-visible");
      expect(result.workspacePath).toBe(resolvedWorkspace);
      expect(result.promptPath).toContain(".vibe-codex/runs/");
      expect(result.rootPromptPath).toContain("VIBE_CODEX_PROMPT.md");
      expect(result.metadataPath).toContain(".vibe-codex/runs/");
      expect(result.copiedToClipboard).toBe(true);
      expect(result.clipboardVerified).toBe(true);
      expect(result.promptSubmittedAutomatically).toBe(false);
      expect(result.requiresManualPaste).toBe(true);
      expect(result.usesCodexExec).toBe(false);
      expect(result.usesShellScript).toBe(false);
      expect(result.appOpened).toBe(true);
      expect(result.message).toContain("Manual-paste delivery only");
      expect(result.message).toContain("does not observe Desktop execution or completion");
      expect(await fs.readFile(codexLog, "utf8")).toBe(`app\n${resolvedWorkspace}\n`);
      expect(await fs.readFile(clipboardLog, "utf8")).toContain("Create one GUI-visible file");
    } finally {
      process.env.PATH = originalPath;
    }
  }, 15_000);

  it("detect_codex_app_server reports unavailable through MCP", async () => {
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "detect_codex_app_server", arguments: {} },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.available).toBe(false);
    expect(payload.result.structuredContent.details.recommendedExecutionMode).toBe("codex-app-thread");
    expect(payload.result.structuredContent.details.fallbackExecutionModes).toEqual(["app-supervised", "codex-app-visible", "ghostty-visible"]);
  });

  it("app-thread tools create run mappings for start, continue, resume, and fork", async () => {
    const appServer = createFakeWsAppServer();
    await new Promise<void>((resolve) => appServer.httpServer.listen(0, resolve));
    try {
      const address = appServer.httpServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `ws://127.0.0.1:${address.port}`;
      const workspace = `${ctx.root}/app-thread`;
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
      const resolvedWorkspace = await import("node:fs/promises").then((fs) => fs.realpath(workspace));
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

      const startResponse = await postMcp({
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: { name: "start_codex_app_thread", arguments: { workspacePath: workspace, userGoal: "Start thread" } },
      }, init.sessionId!);
      const start = parseMcpResponse(await startResponse.text()).result.structuredContent;
      expect(start.runId).toBeTruthy();
      expect(start.threadId).toBe("thread-1");
      expect(start.codexThreadId).toBe("thread-1");
      expect(start.status).toBe("running");
      expect(start.promptSubmittedAutomatically).toBe(true);
      expect(start.requiresManualPaste).toBe(false);
      expect(appServer.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({ cwd: resolvedWorkspace });
      expect(appServer.requests.find((request) => request.method === "turn/start")?.params.input[0].text).toContain("Start thread");

      await waitForCompleted(start.runId);
      const continueResponse = await postMcp({
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: { name: "continue_codex_app_thread", arguments: { threadId: "thread-1", instruction: "Continue thread" } },
      }, init.sessionId!);
      const continued = parseMcpResponse(await continueResponse.text()).result.structuredContent;
      expect(continued.runId).toBeTruthy();
      expect(continued.threadId).toBe("thread-1");
      expect(continued.status).toBe("running");
      expect(continued.workspacePath).toBe(resolvedWorkspace);
      expect(appServer.requests.find((request) => request.method === "turn/start" && request.params.input?.[0]?.text === "Continue thread")?.params).toMatchObject({ threadId: "thread-1" });

      await waitForCompleted(continued.runId);
      const rawTurnResponse = await postMcp({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "run_codex_app_thread_turn", arguments: { threadId: "thread-1", instruction: "Raw thread turn" } },
      }, init.sessionId!);
      const rawTurn = parseMcpResponse(await rawTurnResponse.text()).result.structuredContent;
      expect(rawTurn.threadId).toBe("thread-1");
      expect(rawTurn.promptSubmittedAutomatically).toBe(true);
      expect(rawTurn.requiresManualPaste).toBe(false);
      expect(appServer.requests.find((request) => request.method === "turn/start" && request.params.input?.[0]?.text === "Raw thread turn")?.params.threadId).toBe("thread-1");

      await waitForCompleted(rawTurn.runId);
      const legacyRawTurnResponse = await postMcp({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "run_codex_app_thread_turn", arguments: { threadId: "thread-1", task: "Legacy raw thread turn" } },
      }, init.sessionId!);
      const legacyRawTurn = parseMcpResponse(await legacyRawTurnResponse.text()).result.structuredContent;
      expect(legacyRawTurn.threadId).toBe("thread-1");
      expect(appServer.requests.find((request) => request.method === "turn/start" && request.params.input?.[0]?.text === "Legacy raw thread turn")?.params.threadId).toBe("thread-1");

      await waitForCompleted(legacyRawTurn.runId);
      const sendMessageResponse = await postMcp({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "send_codex_app_thread_message", arguments: { threadId: "thread-1", message: "Plain chat message" } },
      }, init.sessionId!);
      const sentMessage = parseMcpResponse(await sendMessageResponse.text()).result.structuredContent;
      expect(sentMessage.threadId).toBe("thread-1");
      expect(sentMessage.promptSubmittedAutomatically).toBe(true);
      expect(sentMessage.requiresManualPaste).toBe(false);
      expect(appServer.requests.find((request) => request.method === "turn/start" && request.params.input?.[0]?.text === "Plain chat message")?.params.threadId).toBe("thread-1");

      await waitForCompleted(sentMessage.runId);
      const resumeResponse = await postMcp({
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: { name: "resume_codex_app_thread", arguments: { threadId: "thread-1", workspacePath: workspace, prompt: "Resume thread" } },
      }, init.sessionId!);
      const resumed = parseMcpResponse(await resumeResponse.text()).result.structuredContent;
      expect(resumed.runId).toBeTruthy();
      expect(resumed.threadId).toBe("thread-1");
      expect(resumed.status).toBe("running");
      expect(appServer.requests.find((request) => request.method === "thread/resume" && request.params.threadId === "thread-1")?.params).toMatchObject({ threadId: "thread-1", cwd: resolvedWorkspace });
      expect(appServer.requests.find((request) => request.method === "turn/start" && request.params.input?.[0]?.text === "Resume thread")?.params.threadId).toBe("thread-1");

      await waitForCompleted(resumed.runId);
      const forkResponse = await postMcp({
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: { name: "fork_codex_app_thread", arguments: { threadId: "thread-1", workspacePath: workspace, instruction: "Fork thread" } },
      }, init.sessionId!);
      const forked = parseMcpResponse(await forkResponse.text()).result.structuredContent;
      expect(forked.runId).toBeTruthy();
      expect(forked.threadId).toBe("thread-2");
      expect(forked.codexThreadId).toBe("thread-2");
      expect(forked.sourceThreadId).toBe("thread-1");
      expect(appServer.requests.find((request) => request.method === "thread/fork")?.params).toMatchObject({ threadId: "thread-1", cwd: resolvedWorkspace });

      await waitForCompleted(forked.runId);
      ctx.config.codexBin = "definitely-not-installed-codex";
      const startViaGenericResponse = await postMcp({
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: {
          name: "start_codex_task",
          arguments: {
            workspacePath: workspace,
            userGoal: "Start through generic task tool",
            executionMode: "codex-app-thread",
          },
        },
      }, init.sessionId!);
      const genericStart = parseMcpResponse(await startViaGenericResponse.text()).result.structuredContent;
      expect(genericStart.runId).toBeTruthy();
      expect(genericStart.threadId).toBe("thread-1-2");
      expect(genericStart.codexThreadId).toBe("thread-1-2");
      expect(genericStart.status).toBe("running");
      expect(genericStart.executionMode).toBe("codex-app-thread");

      const statusResponse = await postMcp({
        jsonrpc: "2.0",
        id: 26,
        method: "tools/call",
        params: { name: "get_codex_app_thread_status", arguments: { threadId: "thread-1" } },
      }, init.sessionId!);
      const status = parseMcpResponse(await statusResponse.text()).result.structuredContent;
      expect(status.threadId).toBe("thread-1");
      expect(status.status).toBe("completed");
      expect(appServer.requests.find((request) => request.method === "thread/read")?.params.threadId).toBe("thread-1");
    } finally {
      await appServer.close();
    }
  });

  it("project tools reuse registered workspaces and send no-paste app-thread prompts", async () => {
    const appServer = createFakeWsAppServer({ threadId: "project-thread-1" });
    await new Promise<void>((resolve) => appServer.httpServer.listen(0, resolve));
    try {
      const address = appServer.httpServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `ws://127.0.0.1:${address.port}`;
      const workspace = `${ctx.root}/registered-project`;
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
      const resolvedWorkspace = await import("node:fs/promises").then((fs) => fs.realpath(workspace));
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

      const registerResponse = await postMcp({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "register_project", arguments: { name: "Registered Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
      }, init.sessionId!);
      const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;
      expect(registered.createdWorkspace).toBe(false);
      expect(registered.project.path).toBe(resolvedWorkspace);

      const startResponse = await postMcp({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "start_project_task", arguments: { projectRef: "Registered Project", userGoal: "Project start goal" } },
      }, init.sessionId!);
      const started = parseMcpResponse(await startResponse.text()).result.structuredContent;
      expect(started.project.id).toBe(registered.project.id);
      expect(started.createdWorkspace).toBe(false);
      expect(started.noPaste).toBe(true);
      expect(started.threadId).toBe("project-thread-1");
      const startParams = appServer.requests.find((request) => request.method === "thread/start")?.params;
      expect(startParams.cwd).toBe(resolvedWorkspace);
      const startTurn = appServer.requests.find((request) => request.method === "turn/start" && request.params.threadId === "project-thread-1")?.params;
      expect(startTurn.input[0].text).toContain("Source: ChatGPT via Vibe Codex");
      expect(startTurn.input[0].text).toContain(`projectId: ${registered.project.id}`);
      expect(startTurn.input[0].text).toContain("Project start goal");

      await waitForCompleted(started.runId);
      const continueResponse = await postMcp({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "continue_project_task", arguments: { projectRef: registered.project.id, instruction: "Continue project" } },
      }, init.sessionId!);
      const continued = parseMcpResponse(await continueResponse.text()).result.structuredContent;
      expect(continued.threadId).toBe("project-thread-1");
      const continueTurn = appServer.requests.filter((request) => request.method === "turn/start" && request.params.threadId === "project-thread-1").at(-1)?.params;
      expect(continueTurn.input[0].text).toContain("Continue project");
      expect(continueTurn.input[0].text).toContain("codexThreadId: project-thread-1");

      const runsResponse = await postMcp({
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: { name: "list_project_runs", arguments: { projectRef: registered.project.id } },
      }, init.sessionId!);
      const runs = parseMcpResponse(await runsResponse.text()).result.structuredContent.runs;
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.every((run: any) => run.metadata.projectId === registered.project.id)).toBe(true);
    } finally {
      await appServer.close();
    }
  });

  it("records partial project thread mapping when turn/start fails after thread creation", async () => {
    const requests: Array<{ method?: string; params?: any }> = [];
    const failingServer = createNodeHttpServer((req, res) => {
      if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz" || req.url === "/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404).end();
    });
    const failingWs = new WebSocketServer({ server: failingServer });
    failingWs.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString("utf8"));
        if (!request.id) return;
        requests.push({ method: request.method, params: request.params });
        const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        if (request.method === "initialize") return respond({ protocolVersion: "0.1" });
        if (request.method === "thread/start") return respond({ thread: { id: "partial-thread-1", status: { type: "idle" } } });
        if (request.method === "turn/start") return socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "turn rejected" } }));
      });
    });
    await new Promise<void>((resolve) => failingServer.listen(0, resolve));
    try {
      const address = failingServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `ws://127.0.0.1:${address.port}`;
      const workspace = `${ctx.root}/partial-project`;
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
      const registerResponse = await postMcp({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "register_project", arguments: { name: "Partial Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
      }, init.sessionId!);
      const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;
      const startResponse = await postMcp({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "start_project_task", arguments: { projectRef: registered.project.id, userGoal: "Will fail after thread" } },
      }, init.sessionId!);
      const failed = parseMcpResponse(await startResponse.text());
      expect(failed.result.isError).toBe(true);
      expect(failed.result.structuredContent.error.details.codexThreadId).toBe("partial-thread-1");
      const projectResponse = await postMcp({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        params: { name: "get_project", arguments: { projectRef: registered.project.id } },
      }, init.sessionId!);
      const project = parseMcpResponse(await projectResponse.text()).result.structuredContent.project;
      expect(project.defaultCodexThreadId).toBe("partial-thread-1");
      const runsResponse = await postMcp({
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: { name: "list_project_runs", arguments: { projectRef: registered.project.id } },
      }, init.sessionId!);
      const runs = parseMcpResponse(await runsResponse.text()).result.structuredContent.runs;
      expect(runs[0].status).toBe("failed");
      expect(runs[0].metadata.codexThreadId).toBe("partial-thread-1");
      expect(runs[0].metadata.turnStartFailed).toBe(true);
      expect(requests.map((request) => request.method)).toContain("thread/start");
      expect(requests.map((request) => request.method)).toContain("turn/start");
    } finally {
      await closeFakeServer(failingServer, failingWs);
    }
  });

  it("marks continue_project_task failed when turn/start fails after thread resume", async () => {
    const requests: Array<{ method?: string; params?: any }> = [];
    const failingServer = createNodeHttpServer((req, res) => {
      if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz" || req.url === "/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404).end();
    });
    let sourceCwd = "";
    const failingWs = new WebSocketServer({ server: failingServer });
    failingWs.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString("utf8"));
        if (!request.id) return;
        requests.push({ method: request.method, params: request.params });
        const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        if (request.method === "initialize") return respond({ protocolVersion: "0.1" });
        if (request.method === "thread/read" || request.method === "thread/resume") return respond({ thread: { id: request.params.threadId, cwd: sourceCwd, turns: [], status: { type: "idle" } } });
        if (request.method === "turn/start") return socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "turn rejected" } }));
      });
    });
    await new Promise<void>((resolve) => failingServer.listen(0, resolve));
    try {
      const address = failingServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `ws://127.0.0.1:${address.port}`;
      const workspace = `${ctx.root}/partial-continue-project`;
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
      sourceCwd = await fs.realpath(workspace);
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
      const registerResponse = await postMcp({
        jsonrpc: "2.0",
        id: 45,
        method: "tools/call",
        params: { name: "register_project", arguments: { name: "Partial Continue Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
      }, init.sessionId!);
      const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;
      // The owner has remembered this existing thread for the same workspace.
      store.updateProject(registered.project.id, { recentCodexThreadIds: ["existing-thread"] });
      await (await postMcp({
        jsonrpc: "2.0",
        id: 46,
        method: "tools/call",
        params: { name: "set_project_default_thread", arguments: { projectRef: registered.project.id, codexThreadId: "existing-thread" } },
      }, init.sessionId!)).text();
      const continueResponse = await postMcp({
        jsonrpc: "2.0",
        id: 47,
        method: "tools/call",
        params: { name: "continue_project_task", arguments: { projectRef: registered.project.id, instruction: "Will fail after resume" } },
      }, init.sessionId!);
      const failed = parseMcpResponse(await continueResponse.text());
      expect(failed.result.isError).toBe(true);
      expect(failed.result.structuredContent.error.details.codexThreadId).toBe("existing-thread");
      expect(failed.result.structuredContent.error.details.turnStartFailed).toBe(true);

      const runsResponse = await postMcp({
        jsonrpc: "2.0",
        id: 48,
        method: "tools/call",
        params: { name: "list_project_runs", arguments: { projectRef: registered.project.id } },
      }, init.sessionId!);
      const runs = parseMcpResponse(await runsResponse.text()).result.structuredContent.runs;
      expect(runs[0].status).toBe("failed");
      expect(runs[0].metadata.codexThreadId).toBe("existing-thread");
      expect(runs[0].metadata.turnStartFailed).toBe(true);
      expect(requests.map((request) => request.method)).toContain("thread/resume");
      expect(requests.map((request) => request.method)).toContain("turn/start");
    } finally {
      await closeFakeServer(failingServer, failingWs);
    }
  });

  it("project app-thread auto-starts a local app-server through the manager", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const net = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        server.close(() => resolve(address.port));
      });
    });
    const fakeCodex = path.join(ctx.root, "fake-codex");
    await fs.writeFile(fakeCodex, `#!/usr/bin/env node
const http = require("node:http");
const { createRequire } = require("node:module");
const requireFromCwd = createRequire(process.cwd() + "/package.json");
const { WebSocketServer } = requireFromCwd("ws");
const listenArg = process.argv[process.argv.indexOf("--listen") + 1];
const url = new URL(listenArg);
const server = http.createServer((req, res) => {
  const send = (payload) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) return send({ status: "ok" });
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server });
let cwd = "";
let turn = null;
wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString("utf8"));
    if (!request.id) return;
    const respond = (result) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    if (request.method === "initialize") return respond({ protocolVersion: "0.1" });
    if (request.method === "thread/start") { cwd = request.params.cwd; return respond({ thread: { id: "auto-thread", cwd, turns: [], status: { type: "idle" } } }); }
    if (request.method === "thread/read" || request.method === "thread/resume") return respond({ thread: { id: request.params.threadId, cwd, turns: turn ? [turn] : [], status: { type: "idle" } } });
    if (request.method === "turn/start") {
      turn = { id: "auto-turn", status: "inProgress", items: [] };
      respond({ turn });
      setTimeout(() => {
        turn = { ...turn, status: "completed", items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Auto answer" }] };
        socket.send(JSON.stringify({ method: "turn/completed", params: { threadId: request.params.threadId, turn } }));
      }, 40);
      return;
    }
    return socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
  });
});
server.listen(Number(url.port), url.hostname);
process.on("SIGTERM", () => wss.close(() => server.close(() => process.exit(0))));
`);
    await fs.chmod(fakeCodex, 0o755);
    ctx.config.codexAppServerMode = "auto";
    ctx.config.codexAppServerUrl = undefined;
    ctx.config.codexAppServerPort = port;
    ctx.config.codexBin = fakeCodex;

    const workspace = `${ctx.root}/auto-managed-project`;
    await fs.mkdir(workspace);
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

    const registerResponse = await postMcp({
      jsonrpc: "2.0",
      id: 36,
      method: "tools/call",
      params: { name: "register_project", arguments: { name: "Auto Managed Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
    }, init.sessionId!);
    const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;

    const startResponse = await postMcp({
      jsonrpc: "2.0",
      id: 37,
      method: "tools/call",
      params: { name: "start_project_task", arguments: { projectRef: registered.project.id, userGoal: "Auto start goal" } },
    }, init.sessionId!);
    const started = parseMcpResponse(await startResponse.text()).result.structuredContent;
    expect(started.threadId).toBe("auto-thread");
    expect(started.noPaste).toBe(true);
    expect(started.promptSubmittedAutomatically).toBe(true);
    expect(started.requiresManualPaste).toBe(false);
    expect(started.usesCodexExec).toBe(false);
    expect(started.usesShellScript).toBe(false);
    const managed = await import("../src/codex/codexAppServerManager.js").then(({ detectManagedCodexAppServer }) => detectManagedCodexAppServer(ctx.config));
    expect(managed.startedByVibeCodex).toBe(true);
    expect(managed.url).toBe(`ws://127.0.0.1:${port}`);
    expect(managed.listenUrl).toBe(`ws://127.0.0.1:${port}`);

    await waitForCompleted(started.runId);
    const continueResponse = await postMcp({
      jsonrpc: "2.0",
      id: 38,
      method: "tools/call",
      params: { name: "continue_project_task", arguments: { projectRef: registered.project.id, instruction: "Reuse default thread" } },
    }, init.sessionId!);
    const continued = parseMcpResponse(await continueResponse.text()).result.structuredContent;
    expect(continued.threadId).toBe("auto-thread");
    expect(continued.project.defaultCodexThreadId).toBe("auto-thread");

    const stopResponse = await postMcp({
      jsonrpc: "2.0",
      id: 39,
      method: "tools/call",
      params: { name: "stop_codex_app_server", arguments: {} },
    }, init.sessionId!);
    expect(parseMcpResponse(await stopResponse.text()).result.structuredContent.ownerActionRequired).toBe(true);
  });

  it("start_project_task returns a clear fallback when app-server is unavailable", async () => {
    const workspace = `${ctx.root}/registered-no-server`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    await ownerGrantWorkspace(workspace);
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const registerResponse = await postMcp({
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "register_project", arguments: { name: "No Server Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
    }, init.sessionId!);
    const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;
    const startResponse = await postMcp({
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: { name: "start_project_task", arguments: { projectRef: registered.project.id, userGoal: "No server goal" } },
    }, init.sessionId!);
    const payload = parseMcpResponse(await startResponse.text());
    expect(payload.result.isError).toBe(true);
    expect(payload.result.structuredContent.error.code).toBe("CODEX_APP_SERVER_UNAVAILABLE");
    expect(payload.result.structuredContent.error.details.recommendedExecutionMode).toBe("codex-app-thread");
    expect(payload.result.structuredContent.error.details.fallbackExecutionModes).toEqual(["app-supervised", "codex-app-visible", "ghostty-visible"]);
  });

  it("start_codex_task fails clearly when workspace is not Git", async () => {
    const workspace = `${ctx.root}/not-git`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await ownerGrantWorkspace(workspace);
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "start_codex_task",
        arguments: {
          workspacePath: workspace,
          userGoal: "Say hello",
          executionMode: "terminal-visible",
        },
      },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(payload.result.isError).toBe(true);
    expect(payload.result.structuredContent.error.message).toContain("not a Git repository");
    expect(payload.result.structuredContent.error.message).toContain("will not auto-use --skip-git-repo-check");
  });
});
