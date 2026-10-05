import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerWsClient,
  continueCodexAppThreadWs,
  forkCodexAppThreadWs,
  getCodexAppThreadStatusWs,
  startCodexAppThreadWs,
  turnStartParams,
} from "../src/codex/codexAppServerWsClient.js";
import { tempConfig } from "./helpers.js";

async function withFakeWsServer(
  handler: (request: any, send: (response: any) => void, socket: WebSocket) => void,
  fn: (url: string, requests: any[]) => Promise<void>,
) {
  const requests: any[] = [];
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      requests.push(request);
      handler(request, (response) => socket.send(JSON.stringify(response)), socket);
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  try {
    await fn(`ws://127.0.0.1:${address.port}`, requests);
  } finally {
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise<void>((resolve) => wsServer.close(() => httpServer.close(() => resolve())));
  }
}

function respondOk(request: any, send: (response: any) => void) {
  if (!request.id) return;
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "0.1" } });
  if (request.method === "thread/start") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-1", status: { type: "running" } } } });
  if (request.method === "thread/resume") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: request.params.threadId, status: { type: "running" } } } });
  if (request.method === "thread/fork") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-2", status: { type: "running" } } } });
  if (request.method === "thread/read") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: request.params.threadId, status: { type: "running" } } } });
  if (request.method === "turn/start") return send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-1", status: "running" } } });
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
}

describe("Codex app-server WebSocket client", () => {
  it("matches JSON-RPC responses and captures notifications", async () => {
    await withFakeWsServer((request, send) => {
      if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      if (request.method === "ping") {
        send({ jsonrpc: "2.0", method: "turn/started", params: { turnId: "turn-1" } });
        send({ jsonrpc: "2.0", id: request.id, result: { pong: true } });
      }
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500 });
      await client.connect();
      await client.initialize();
      const result = await client.request("ping", { ok: true });
      expect(result).toEqual({ pong: true });
      expect(client.recentEvents().some((event) => (event.message as any).method === "turn/started")).toBe(true);
      client.close();
    });
  });

  it("reports method errors and timeouts", async () => {
    await withFakeWsServer((request, send) => {
      if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      if (request.method === "bad") return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "No such method" } });
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 50 });
      await client.connect();
      await client.initialize();
      await expect(client.request("bad")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      await expect(client.request("never")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      client.close();
    });
  });

  it("preserves the created thread id when turn/start fails", async () => {
    const ctx = await tempConfig();
    try {
      await withFakeWsServer((request, send) => {
        if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
        if (request.method === "thread/start") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-created", status: { type: "idle" } } } });
        if (request.method === "turn/start") return send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "turn rejected" } });
      }, async (url) => {
        ctx.config.codexAppServerUrl = url;
        await expect(startCodexAppThreadWs({ workspacePath: ctx.root, prompt: "start prompt", config: ctx.config })).rejects.toMatchObject({
          code: "CODEX_APP_SERVER_UNAVAILABLE",
          details: {
            codexThreadId: "thread-created",
            threadId: "thread-created",
            turnStartFailed: true,
          },
        });
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("sends thread start, resume, fork, status, and turn prompt shapes", async () => {
    const ctx = await tempConfig();
    try {
      await withFakeWsServer(respondOk, async (url, requests) => {
        ctx.config.codexAppServerUrl = url;
        const started = await startCodexAppThreadWs({ workspacePath: ctx.root, prompt: "start prompt", config: ctx.config });
        const continued = await continueCodexAppThreadWs({ threadId: started.threadId, workspacePath: ctx.root, instruction: "continue prompt", config: ctx.config });
        const forked = await forkCodexAppThreadWs({ threadId: continued.threadId, workspacePath: ctx.root, instruction: "fork prompt", config: ctx.config });
        const status = await getCodexAppThreadStatusWs({ threadId: forked.threadId, config: ctx.config });
        expect(started.threadId).toBe("thread-1");
        expect(forked.threadId).toBe("thread-2");
        expect(status).toMatchObject({ thread: { id: "thread-2" } });
        expect(requests.find((request) => request.method === "thread/start").params).toMatchObject({ cwd: ctx.root, runtimeWorkspaceRoots: [ctx.root] });
        expect(requests.find((request) => request.method === "thread/resume").params).toMatchObject({ threadId: "thread-1", persistExtendedHistory: false });
        expect(requests.find((request) => request.method === "thread/fork").params).toMatchObject({ threadId: "thread-1", cwd: ctx.root });
        expect(requests.find((request) => request.method === "thread/read").params).toMatchObject({ threadId: "thread-2", includeTurns: true });
        const turnStarts = requests.filter((request) => request.method === "turn/start");
        expect(turnStarts.map((request) => request.params.input[0].text)).toEqual(["start prompt", "continue prompt", "fork prompt"]);
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("classifies colliding server request ids before outbound response ids", async () => {
    const notifications: string[] = [];
    let serverRequestId: string | number | undefined;
    await withFakeWsServer((request, send) => {
      if (request.method === "ping") send({ id: request.id, method: "item/commandExecution/requestApproval", params: { command: "git status" } });
      if (!request.method && request.result) send({ id: request.id, result: { pong: true } });
    }, async (url, requests) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500,
        onNotification: (method) => notifications.push(method),
        onServerRequest: async (request) => { serverRequestId = request.id; await client.respond(request.id, { decision: "decline" }); },
      });
      expect(await client.request("ping")).toEqual({ pong: true });
      expect(serverRequestId).toBe(1);
      expect(requests).toContainEqual({ jsonrpc: "2.0", id: 1, result: { decision: "decline" } });
      expect(notifications).toEqual([]);
      client.close();
    });
  });

  it("refuses unsupported server requests explicitly and contains failing hooks", async () => {
    await withFakeWsServer((request, send) => {
      if (request.method === "ping") send({ id: "privileged", method: "account/chatgptAuthTokens/refresh", params: {} });
      if (request.id === "privileged" && request.error) send({ id: 1, result: request.error });
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500 });
      expect(await client.request("ping")).toMatchObject({ code: -32601 });
      client.close();
    });
    await withFakeWsServer((request, send) => {
      if (request.method === "ping") send({ id: 9, method: "unsupported", params: {} });
      if (request.id === 9 && request.error) send({ id: 1, result: request.error });
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500, onServerRequest: () => { throw new Error("closed db"); } });
      expect(await client.request("ping")).toMatchObject({ code: -32603 });
      client.close();
    });
  });

  it("bounds retained events and handles disconnect only once", async () => {
    let disconnects = 0;
    await withFakeWsServer((request, send) => {
      if (request.method !== "ping") return;
      for (let i = 0; i < 250; i++) send({ method: "progress", params: { i, output: "x".repeat(20_000) } });
      send({ id: request.id, result: true });
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 1000, onDisconnect: () => { disconnects++; } });
      await client.request("ping");
      expect(client.recentEvents(1000)).toHaveLength(200);
      expect(JSON.stringify(client.recentEvents(1000)).length).toBeLessThan(3_500_000);
      expect(client.recentEvents(0)).toEqual([]);
      client.close();
      expect(disconnects).toBe(0); // deliberate close is not connection failure
    });
  });

  it("rejects pending RPCs on unexpected disconnect and contains disconnect-hook errors", async () => {
    let disconnects = 0;
    await withFakeWsServer((_request, _send, socket) => socket.close(), async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500, onDisconnect: () => { disconnects++; throw new Error("database closed"); } });
      await expect(client.request("pending")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      expect(disconnects).toBe(1);
      await expect(client.request("after-disconnect")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      client.close();
      expect(disconnects).toBe(1);
    });
  });

  it("shares concurrent connection attempts and rejects calls after close", async () => {
    await withFakeWsServer((request, send) => { if (request.method) send({ id: request.id, result: request.method }); }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500 });
      expect(await Promise.all([client.request("first"), client.request("second")])).toEqual(["first", "second"]);
      client.close();
      await expect(client.request("third")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
    });
  });

  it("builds turn/start input as one text item", async () => {
    const ctx = await tempConfig();
    try {
      expect(turnStartParams({ threadId: "thread-1", workspacePath: ctx.root, prompt: "hello", config: ctx.config })).toMatchObject({
        threadId: "thread-1",
        cwd: ctx.root,
        input: [{ type: "text", text: "hello", text_elements: [] }],
      });
    } finally {
      await ctx.cleanup();
    }
  });
});
