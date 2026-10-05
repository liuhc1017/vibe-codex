import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { getRunCoordinator, RunCoordinator } from "../src/codex/runCoordinator.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { Config } from "../src/config/types.js";
import { gitInit } from "../src/workspace/git.js";
import { tempConfig } from "./helpers.js";

type Send = (message: unknown) => void;
type Fake = {
  config: Config;
  store: RunStore;
  coordinator: RunCoordinator;
  root: string;
  requests: any[];
  sockets: WebSocket[];
  history: Map<string, any[]>;
  send?: Send;
  complete: (status?: string, items?: any[]) => void;
};
type Handler = (request: any, send: Send, socket: WebSocket, fake: Fake) => boolean | void;

async function withFake(fn: (fake: Fake) => Promise<void>, handler?: Handler) {
  const ctx = await tempConfig();
  const store = initRunStore(ctx.config.databasePath);
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); });
  const wsServer = new WebSocketServer({ server });
  const fake: Fake = { config: ctx.config, store, coordinator: new RunCoordinator(ctx.config, store), root: await fs.realpath(ctx.root),
    requests: [], sockets: [], history: new Map(), complete: () => undefined };
  let threadCounter = 0;
  let turnCounter = 0;
  let latestThread = "";
  let latestTurn = "";
  wsServer.on("connection", (socket) => {
    fake.sockets.push(socket);
    const send: Send = (message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      fake.requests.push(request);
      if (handler?.(request, send, socket, fake)) return;
      if (request.id == null || !request.method) return;
      const reply = (result: unknown) => send({ id: request.id, result });
      if (request.method === "initialize") return reply({ ok: true });
      if (request.method === "thread/start" || request.method === "thread/fork") {
        latestThread = `thread-${++threadCounter}`;
        fake.history.set(latestThread, []);
        return reply({ thread: { id: latestThread, cwd: fake.root, status: { type: "idle" }, turns: [] } });
      }
      if (request.method === "thread/resume") {
        latestThread = request.params.threadId;
        return reply({ thread: { id: latestThread, cwd: fake.root, status: { type: "idle" }, turns: fake.history.get(latestThread) ?? [] } });
      }
      if (request.method === "turn/start") {
        fake.send = send;
        latestThread = request.params.threadId;
        latestTurn = `turn-${++turnCounter}`;
        const turn = { id: latestTurn, status: "inProgress", items: [] };
        fake.history.set(latestThread, [...(fake.history.get(latestThread) ?? []), turn]);
        fake.complete = (status = "completed", items = []) => {
          const completed = { id: latestTurn, status, items };
          fake.history.set(latestThread, (fake.history.get(latestThread) ?? []).map((value) => value.id === latestTurn ? completed : value));
          send({ method: "turn/completed", params: { threadId: latestThread, turn: completed } });
        };
        return reply({ turn });
      }
      if (request.method === "thread/read") return reply({ thread: { id: request.params.threadId, cwd: fake.root, turns: fake.history.get(request.params.threadId) ?? [] } });
      if (request.method === "turn/interrupt") {
        reply({});
        fake.complete("interrupted");
        return;
      }
      send({ id: request.id, error: { code: -32601, message: "Unsupported fake method" } });
    });
  });
  try {
    await gitInit(ctx.root, ctx.config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    ctx.config.codexAppServerUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx.config.codexTimeoutMs = 2_000;
    await fn(fake);
  } finally {
    await fake.coordinator.close();
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise<void>((resolve) => wsServer.close(() => server.close(() => resolve())));
    if (store.db.open) store.db.close();
    await ctx.cleanup();
  }
}

function start(fake: Fake, extra: Partial<Parameters<RunCoordinator["start"]>[0]> = {}) {
  return fake.coordinator.start({ workspacePath: fake.root, prompt: "Test task", autonomy: "workspace", ...extra });
}
function params(run: any, extra: Record<string, unknown> = {}) {
  return { threadId: run.metadata.codexThreadId, turnId: run.metadata.codexTurnId, itemId: "item-1", ...extra };
}
async function waitStatus(fake: Fake, runId: string, status: string) {
  await expect.poll(() => fake.store.getRun(runId)?.status, { timeout: 1500 }).toBe(status);
}
async function request(fake: Fake, run: any, method: string, extra: Record<string, unknown> = {}, id: string | number = "approval") {
  fake.send!({ id, method, params: params(run, extra) });
  await expect.poll(() => fake.coordinator.pendingRequests().length).toBe(1);
  return fake.coordinator.pendingRequests()[0]!;
}

describe("RunCoordinator lifecycle", () => {
  it("returns after ack, retains connection, persists output and the final answer, then closes", async () => {
    await withFake(async (fake) => {
      const run = await start(fake, { prompt: (id) => `Task for ${id}` });
      expect(run.status).toBe("running");
      expect(run.prompt).toBe(`Task for ${run.id}`);
      expect(run.metadata).toMatchObject({ codexThreadId: "thread-1", codexTurnId: "turn-1", promptSubmittedAutomatically: true });
      expect(fake.sockets[0]!.readyState).toBe(WebSocket.OPEN);
      fake.send!({ method: "item/agentMessage/delta", params: params(run, { delta: "Working", itemId: "assistant-1" }) });
      fake.send!({ method: "item/commandExecution/outputDelta", params: params(run, { delta: "tests passed", itemId: "cmd-1" }) });
      await expect.poll(() => fake.store.getRun(run.id)?.stdout).toBe("Working");
      fake.send!({ method: "item/completed", params: params(run, { item: { id: "assistant-1", type: "agentMessage", text: "Working now", phase: "commentary" } }) });
      fake.complete("completed", [{ id: "assistant-1", type: "agentMessage", text: "Working now", phase: "commentary" }, { id: "answer", type: "agentMessage", text: "Implemented and verified.", phase: "final_answer" }]);
      await waitStatus(fake, run.id, "completed");
      const final = fake.store.getRun(run.id)!;
      expect(final.stdout).toBe("Working now\n\nImplemented and verified.");
      expect(final.summary).toBe("Implemented and verified.");
      expect(final.metadata).toMatchObject({ commandOutput: "tests passed", finalAnswer: "Implemented and verified.", codexTurnStatus: "completed" });
      expect(final.exitCode).toBe(0);
      await expect.poll(() => fake.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
    });
  });

  it("captures pre-ack output/completion without regressing terminal status", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      expect(run.status).toBe("completed");
      expect(run.stdout).toBe("Already done");
      expect(run.summary).toBe("Already done");
    }, (rpc, send) => {
      if (rpc.method !== "turn/start") return false;
      const p = { threadId: rpc.params.threadId, turnId: "early", itemId: "a" };
      send({ method: "turn/started", params: { threadId: p.threadId, turn: { id: "early", status: "inProgress", items: [] } } });
      send({ method: "item/agentMessage/delta", params: { ...p, delta: "Already done" } });
      send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "early", status: "completed", items: [] } } });
      send({ method: "turn/started", params: { threadId: p.threadId, turn: { id: "early", status: "inProgress", items: [] } } });
      send({ id: rpc.id, result: { turn: { id: "early", status: "inProgress", items: [] } } });
      return true;
    });
  });

  it("does not mistake another turn's late events for this run", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      fake.send!({ method: "turn/completed", params: { threadId: run.metadata!.codexThreadId, turn: { id: "old-turn", status: "failed", items: [] } } });
      fake.send!({ method: "item/agentMessage/delta", params: params(run, { turnId: "old-turn", delta: "stale" }) });
      const pending = await request(fake, run, "item/commandExecution/requestApproval", { command: "git status" });
      expect(fake.store.getRun(run.id)?.stdout).toBe("");
      expect(fake.store.getRun(run.id)?.status).toBe("waiting_approval");
      await fake.coordinator.respond(pending.id, { decision: "decline" });
      fake.complete();
      await waitStatus(fake, run.id, "completed");
    });
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("validates one-shot decisions for %s", async (method) => {
    await withFake(async (fake) => {
      const run = await start(fake);
      const pending = await request(fake, run, method, { command: "git status", availableDecisions: ["accept", "decline", "cancel", "acceptForSession"] }, 3);
      expect(pending).toMatchObject({ runId: run.id, method });
      expect(pending.id).not.toBe("3");
      expect(fake.store.getRun(run.id)?.status).toBe("waiting_approval");
      for (const invalid of [{ decision: "acceptForSession" }, { decision: { acceptWithExecpolicyAmendment: {} } }, { decision: "accept", grantRoot: fake.root }]) {
        await expect(fake.coordinator.respond(pending.id, invalid)).rejects.toMatchObject({ code: "INVALID_CODEX_RESPONSE" });
      }
      await fake.coordinator.respond(pending.id, { decision: "decline" });
      await expect.poll(() => fake.requests).toContainEqual({ jsonrpc: "2.0", id: 3, result: { decision: "decline" } });
      expect(fake.coordinator.pendingRequests()).toEqual([]);
      expect(fake.store.getRun(run.id)?.status).toBe("running");
      await expect(fake.coordinator.respond(pending.id, { decision: "accept" })).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_FOUND" });
    });
  });

  it("keeps a pre-ack approval and permits accept/cancel without id collisions", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      expect(run.status).toBe("waiting_approval");
      const pending = fake.coordinator.pendingRequests()[0]!;
      await fake.coordinator.respond(pending.id, { decision: "accept" });
      await expect.poll(() => fake.requests.some((rpc) => rpc.id === 3 && rpc.result?.decision === "accept")).toBe(true);
      const second = await request(fake, run, "item/fileChange/requestApproval", {}, "next");
      await fake.coordinator.respond(second.id, { decision: "cancel" });
      await expect.poll(() => fake.requests.some((rpc) => rpc.id === "next" && rpc.result?.decision === "cancel")).toBe(true);
    }, (rpc, send, _socket, fake) => {
      if (rpc.method !== "turn/start") return false;
      fake.send = send;
      send({ id: rpc.id, method: "item/commandExecution/requestApproval", params: { threadId: rpc.params.threadId, turnId: "turn-1", itemId: "cmd", command: "git status" } });
      send({ id: rpc.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
      return true;
    });
  });

  it("requires structured answers for exact questions and handles server cancellation", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      const questions = [{ id: "choice", header: "Choice", question: "Which?", options: [{ label: "A" }, { label: "B" }] }, { id: "detail", header: "Detail", question: "Details?", options: null }];
      const pending = await request(fake, run, "item/tool/requestUserInput", { questions });
      expect(fake.store.getRun(run.id)?.status).toBe("waiting_input");
      for (const invalid of [{ answers: { choice: "A", detail: "text" } }, { answers: { choice: { answers: ["C"] }, detail: { answers: ["text"] } } }, { answers: { choice: { answers: ["A"] } } }]) {
        await expect(fake.coordinator.respond(pending.id, invalid)).rejects.toMatchObject({ code: "INVALID_CODEX_RESPONSE" });
      }
      await fake.coordinator.respond(pending.id, { answers: { choice: { answers: ["A"] }, detail: { answers: ["text"] } } });
      const next = await request(fake, run, "item/tool/requestUserInput", { questions }, "second");
      fake.send!({ method: "serverRequest/resolved", params: { threadId: run.metadata!.codexThreadId, requestId: "second" } });
      await expect.poll(() => fake.coordinator.pendingRequests().length).toBe(0);
      await expect(fake.coordinator.respond(next.id, {})).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_FOUND" });
      expect(fake.store.getRun(run.id)?.status).toBe("running");
    });
  });

  it("fails closed on unsupported privileged requests and expansion fields", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      const examples = [
        ["item/permissions/requestApproval", {}],
        ["account/chatgptAuthTokens/refresh", {}],
        ["item/commandExecution/requestApproval", { additionalPermissions: { network: { enabled: true } } }],
        ["item/fileChange/requestApproval", { grantRoot: "/" }],
        ["item/commandExecution/requestApproval", { proposedExecpolicyAmendment: ["rm"] }],
        ["item/tool/requestUserInput", { questions: [{ id: "secret", question: "Password?", isSecret: true }] }],
      ] as const;
      examples.forEach(([method, extra], i) => fake.send!({ id: `unsafe-${i}`, method, params: params(run, extra) }));
      await expect.poll(() => fake.requests.filter((rpc) => String(rpc.id).startsWith("unsafe-") && rpc.error).length).toBe(examples.length);
      expect(fake.coordinator.pendingRequests()).toEqual([]);
      expect(fake.requests.filter((rpc) => String(rpc.id).startsWith("unsafe-")).every((rpc) => rpc.error && !rpc.result)).toBe(true);
      expect(fake.store.getRun(run.id)?.status).toBe("running");
    });
  });

  it("rejects competing starts before awaits, including thread conflicts across workspaces", async () => {
    await withFake(async (fake) => {
      const first = start(fake);
      await expect(start(fake)).rejects.toMatchObject({ code: "RUN_CONFLICT" });
      const run = await first;
      const secondWorkspace = path.join(fake.root, "other");
      await fs.mkdir(secondWorkspace);
      await gitInit(secondWorkspace, fake.config);
      await expect(start(fake, { workspacePath: secondWorkspace, threadId: run.metadata!.codexThreadId as string })).rejects.toMatchObject({ code: "RUN_CONFLICT" });
      fake.complete();
      await waitStatus(fake, run.id, "completed");
      const followup = await start(fake, { threadId: run.metadata!.codexThreadId as string });
      expect(followup.metadata?.parentRunId).toBe(run.id);
      expect(followup.metadata?.codexTurnId).toBe("turn-2");
    });
  });

  it("releases reservations after path/git failure and rejects manual autonomy", async () => {
    await withFake(async (fake) => {
      await expect(start(fake, { autonomy: "manual" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      const nonGit = path.join(fake.root, "not-a-repo");
      await fs.mkdir(nonGit);
      // Nested directories inherit the outer repository, so use an invalid path.
      await expect(start(fake, { workspacePath: path.join(nonGit, "missing") })).rejects.toBeDefined();
      await expect(start(fake, { workspacePath: path.join(nonGit, "missing") })).rejects.not.toMatchObject({ code: "RUN_CONFLICT" });
      const run = await start(fake);
      expect(run.status).toBe("running");
    });
  });

  it("persists partial thread creation and project mapping when turn/start rejects", async () => {
    await withFake(async (fake) => {
      const project = fake.store.createProject({ name: "Test", path: fake.root, defaultCodexThreadId: "old-thread" });
      let runId = "";
      try { await start(fake, { projectId: project.id, setDefaultThread: false }); } catch (error: any) { runId = error.details.runId; }
      expect(runId).not.toBe("");
      expect(fake.store.getRun(runId)).toMatchObject({ status: "failed", metadata: { codexThreadId: "thread-1", turnStartFailed: true } });
      expect(fake.store.getProject(project.id)).toMatchObject({ defaultCodexThreadId: "old-thread", recentCodexThreadIds: ["thread-1"] });
      await expect(start(fake, { projectId: project.id })).rejects.toMatchObject({ details: { codexThreadId: "thread-2" } });
      expect(fake.store.getProject(project.id)?.defaultCodexThreadId).toBe("thread-2");
    }, (rpc, send) => {
      if (rpc.method !== "turn/start") return false;
      send({ id: rpc.id, error: { code: -32000, message: "Rejected prompt" } });
      return true;
    });
  });

  it("persists uncertain start results and prevents automatic replay", async () => {
    await withFake(async (fake) => {
      fake.config.codexTimeoutMs = 40;
      await expect(start(fake)).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      const run = fake.store.listRuns()[0]!;
      expect(run.status).toBe("recovery_required");
      expect(run.metadata?.codexThreadId).toBe("thread-1");
      await fake.coordinator.reconcile(run.id);
      await expect(start(fake)).rejects.toMatchObject({ code: "RUN_CONFLICT" });
      expect(fake.requests.filter((rpc) => rpc.method === "turn/start")).toHaveLength(1);
    }, (rpc) => rpc.method === "turn/start");
  });

  it("interrupts by exact ids and removes pending approvals only on confirmed terminal state", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      await request(fake, run, "item/commandExecution/requestApproval", { command: "git status" });
      const result = await fake.coordinator.interrupt(run.id);
      expect(result.status).toBe("interrupted");
      expect(fake.coordinator.pendingRequests()).toEqual([]);
      expect(fake.requests.find((rpc) => rpc.method === "turn/interrupt").params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
      expect(await fake.coordinator.interrupt(run.id)).toMatchObject({ status: "interrupted" });
    });
  });

  it("waits for delayed interruption notification rather than assuming the ack is terminal", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      expect((await fake.coordinator.interrupt(run.id)).status).toBe("interrupted");
      expect(fake.requests.some((rpc) => rpc.method === "thread/read")).toBe(false);
    }, (rpc, send, _socket, fake) => {
      if (rpc.method !== "turn/interrupt") return false;
      send({ id: rpc.id, result: {} });
      // Reproduce real app-server cancellation arriving after the former 500ms grace.
      setTimeout(() => fake.complete("interrupted"), 750);
      return true;
    });
  });

  it("retries the exact interrupt when turn acknowledgment precedes engine activation", async () => {
    let attempts = 0;
    await withFake(async (fake) => {
      const run = await start(fake);
      expect((await fake.coordinator.interrupt(run.id)).status).toBe("interrupted");
      const interrupts = fake.requests.filter((rpc) => rpc.method === "turn/interrupt");
      expect(interrupts).toHaveLength(3);
      for (const rpc of interrupts) expect(rpc.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
      expect(fake.requests.filter((rpc) => rpc.method === "turn/start")).toHaveLength(1);
    }, (rpc, send, _socket, fake) => {
      if (rpc.method !== "turn/interrupt") return false;
      if (++attempts < 3) send({ id: rpc.id, error: { code: -32600, message: "no active turn to interrupt" } });
      else { send({ id: rpc.id, result: {} }); fake.complete("interrupted"); }
      return true;
    });
  });

  it("does not claim interrupted when the acknowledgment leaves execution in progress", async () => {
    await withFake(async (fake) => {
      // Avoid the task deadline competing with an intentionally unconfirmed stop.
      fake.config.codexTimeoutMs = 10_000;
      const run = await start(fake);
      expect((await fake.coordinator.interrupt(run.id)).status).toBe("recovery_required");
      expect(fake.requests.find((rpc) => rpc.method === "thread/read").params.includeTurns).toBe(true);
    }, (rpc, send) => {
      if (rpc.method !== "turn/interrupt") return false;
      send({ id: rpc.id, result: {} });
      return true;
    });
  }, 10_000);

  it("recovers a disconnected completed turn from exact history and closes ephemeral reads", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      await request(fake, run, "item/commandExecution/requestApproval", { command: "git status" });
      fake.history.set("thread-1", [{ id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Recovered result" }] }]);
      fake.sockets[0]!.terminate();
      await waitStatus(fake, run.id, "completed");
      expect(fake.store.getRun(run.id)?.summary).toBe("Recovered result");
      expect(fake.coordinator.pendingRequests()).toEqual([]);
      await expect.poll(() => fake.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
      expect(fake.requests.some((rpc) => rpc.method === "thread/read" && rpc.params.includeTurns === true)).toBe(true);
      expect(fake.requests.filter((rpc) => rpc.method === "turn/start")).toHaveLength(1);
    });
  });

  it("recovers a legacy nested acknowledgment by exact consistent identities without replay", async () => {
    await withFake(async (fake) => {
      const run = fake.store.createRun({ workspacePath: fake.root, status: "recovery_required", autonomy: "workspace", prompt: "Legacy task", command: "codex-app-thread",
        metadata: { executionMode: "codex-app-thread", codexThreadId: "legacy-thread", appServerResponse: {
          threadId: "legacy-thread", turnId: "legacy-turn", threadResponse: { thread: { id: "legacy-thread" } },
          turnResponse: { turn: { id: "legacy-turn", status: "inProgress" } },
        } } });
      fake.history.set("legacy-thread", [{ id: "legacy-turn", status: "completed", items: [
        { id: "answer", type: "agentMessage", phase: "final_answer", text: "Recovered legacy answer" },
      ] }]);
      await fake.coordinator.reconcile(run.id);
      expect(fake.store.getRun(run.id)).toMatchObject({ status: "completed", summary: "Recovered legacy answer",
        metadata: { codexTurnId: "legacy-turn", legacyTurnIdentityRecovered: true } });
      expect(fake.requests.filter((rpc) => ["thread/start", "thread/resume", "turn/start"].includes(rpc.method))).toHaveLength(0);
      expect(fake.requests.find((rpc) => rpc.method === "thread/read").params).toEqual({ threadId: "legacy-thread", includeTurns: true });
    });
  });

  it("does not import conflicting legacy turn acknowledgments", async () => {
    await withFake(async (fake) => {
      const run = fake.store.createRun({ workspacePath: fake.root, status: "recovery_required", autonomy: "workspace", prompt: "Legacy task", command: "codex-app-thread",
        metadata: { executionMode: "codex-app-thread", codexThreadId: "legacy-thread", appServerResponse: {
          threadId: "legacy-thread", turnId: "legacy-turn", threadResponse: { thread: { id: "legacy-thread" } },
          turnResponse: { turn: { id: "another-turn" } },
        } } });
      await fake.coordinator.reconcile(run.id);
      expect(fake.store.getRun(run.id)?.status).toBe("recovery_required");
      expect(fake.store.getRun(run.id)?.metadata?.codexTurnId).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
    });
  });

  it("marks disconnected in-progress execution recovery_required and blocks follow-up", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      fake.sockets[0]!.terminate();
      await waitStatus(fake, run.id, "recovery_required");
      await expect(start(fake)).rejects.toMatchObject({ code: "RUN_CONFLICT" });
      expect(fake.requests.filter((rpc) => rpc.method === "turn/start")).toHaveLength(1);
    });
  });

  it("bounds turn execution with an interrupt and honest terminal recovery", async () => {
    await withFake(async (fake) => {
      fake.config.codexTimeoutMs = 60;
      const run = await start(fake);
      await waitStatus(fake, run.id, "interrupted");
      expect(fake.store.getRun(run.id)?.metadata?.timedOut).toBe(true);
      expect(fake.requests.some((rpc) => rpc.method === "turn/interrupt")).toBe(true);
    });
  });

  it("persists errors, tolerates retry warnings, and ignores post-terminal regressions", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      fake.send!({ method: "error", params: params(run, { error: { message: "Retrying" }, willRetry: true }) });
      await expect.poll(() => fake.store.getRun(run.id)?.stderr).toBe("Retrying");
      expect(fake.store.getRun(run.id)?.status).toBe("running");
      fake.send!({ method: "error", params: params(run, { error: { message: "Permanent failure" }, willRetry: false }) });
      fake.send!({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } } });
      await waitStatus(fake, run.id, "failed");
      expect(fake.store.getRun(run.id)?.stderr).toContain("Permanent failure");
    });
  });

  it("reconciles restart records only against exact turn ids, never the latest turn", async () => {
    await withFake(async (fake) => {
      const recovered = fake.store.createRun({ workspacePath: fake.root, status: "running", autonomy: "workspace", prompt: "saved", command: "codex-app-thread", stdout: "partial", metadata: { executionMode: "codex-app-thread", codexThreadId: "saved-thread", codexTurnId: "saved-turn" } });
      fake.history.set("saved-thread", [{ id: "saved-turn", status: "completed", items: [] }, { id: "latest-turn", status: "failed", items: [] }]);
      await fake.coordinator.reconcile();
      expect(fake.store.getRun(recovered.id)).toMatchObject({ status: "completed", stdout: "partial" });
      const missing = fake.store.createRun({ workspacePath: fake.root, status: "running", autonomy: "workspace", prompt: "missing", command: "codex-app-thread", metadata: { executionMode: "codex-app-thread", codexThreadId: "saved-thread", codexTurnId: "missing-turn" } });
      await fake.coordinator.reconcile(missing.id);
      expect(fake.store.getRun(missing.id)?.status).toBe("recovery_required");
      expect(fake.requests.filter((rpc) => rpc.method === "turn/start" || rpc.method === "thread/resume")).toHaveLength(0);
    });
  });

  it("reconciles failed/interrupted and unknown/missing ids honestly", async () => {
    await withFake(async (fake) => {
      for (const status of ["failed", "interrupted", "inProgress", "unknown"]) {
        const run = fake.store.createRun({ workspacePath: fake.root, status: "recovering", autonomy: "workspace", prompt: "saved", command: "codex-app-thread", metadata: { executionMode: "codex-app-thread", codexThreadId: `thread-${status}`, codexTurnId: "exact" } });
        fake.history.set(`thread-${status}`, [{ id: "exact", status, items: [], error: status === "failed" ? { message: "History error" } : null }]);
        await fake.coordinator.reconcile(run.id);
        expect(fake.store.getRun(run.id)?.status).toBe(status === "failed" || status === "interrupted" ? status : "recovery_required");
      }
      const noId = fake.store.createRun({ workspacePath: fake.root, status: "queued", autonomy: "workspace", prompt: "saved", command: "codex-app-thread", metadata: { executionMode: "codex-app-thread" } });
      await fake.coordinator.reconcile(noId.id);
      expect(fake.store.getRun(noId.id)?.status).toBe("recovery_required");
    });
  });

  it("rejects source threads from other workspaces before resume/fork can reset cwd", async () => {
    await withFake(async (fake) => {
      await expect(start(fake, { threadId: "foreign" })).rejects.toMatchObject({ code: "THREAD_WORKSPACE_MISMATCH" });
      expect(fake.requests.some((rpc) => rpc.method === "thread/resume" || rpc.method === "turn/start")).toBe(false);
    }, (rpc, send, _socket, fake) => {
      if (rpc.method !== "thread/read") return false;
      send({ id: rpc.id, result: { thread: { id: "foreign", cwd: path.dirname(fake.root), turns: [] } } });
      return true;
    });
  });

  it("updates project/fork lineage and retains strict sandbox and untrusted approvals", async () => {
    await withFake(async (fake) => {
      fake.config.defaultCodexApproval = "untrusted";
      fake.config.defaultCodexSandbox = "danger-full-access";
      const project = fake.store.createProject({ name: "Project", path: fake.root });
      const first = await start(fake, { projectId: project.id });
      fake.complete();
      await waitStatus(fake, first.id, "completed");
      const forked = await start(fake, { projectId: project.id, threadId: first.metadata!.codexThreadId as string, fork: true, setDefaultThread: false });
      expect(forked.metadata).toMatchObject({ codexThreadId: "thread-2", sourceCodexThreadId: "thread-1", parentRunId: first.id });
      expect(fake.store.getProject(project.id)?.defaultCodexThreadId).toBe("thread-1");
      for (const rpc of fake.requests.filter((rpc) => rpc.method === "turn/start")) {
        expect(rpc.params).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots: [fake.root], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
      }
      expect(fake.requests.find((rpc) => rpc.method === "thread/start").params.sandbox).toBe("workspace-write");
    });
  });

  it("keeps an explicit relay model on new, resumed and forked turns", async () => {
    await withFake(async (fake) => {
      fake.config.codexModel = "relay-model";
      const first = await start(fake);
      fake.complete();
      await waitStatus(fake, first.id, "completed");
      const resumed = await start(fake, { threadId: first.metadata!.codexThreadId as string });
      fake.complete();
      await waitStatus(fake, resumed.id, "completed");
      await start(fake, { threadId: first.metadata!.codexThreadId as string, fork: true });
      const operations = fake.requests.filter((rpc) => ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(rpc.method));
      expect(operations).toHaveLength(6);
      for (const rpc of operations) expect(rpc.params.model).toBe("relay-model");
    });
  });

  it("bounds events/output and survives database closure and coordinator shutdown", async () => {
    await withFake(async (fake) => {
      fake.config.maxCommandOutputBytes = 100;
      const run = await start(fake);
      for (let i = 0; i < 140; i++) fake.send!({ method: "item/agentMessage/delta", params: params(run, { delta: "x".repeat(20), itemId: "bounded" }) });
      await expect.poll(() => (fake.store.getRun(run.id)?.metadata?.appServerEvents as unknown[])?.length).toBe(100);
      expect(fake.store.getRun(run.id)?.stdout).toHaveLength(100);
      await fake.coordinator.close();
      expect(fake.store.getRun(run.id)?.status).toBe("recovery_required");
      expect(fake.coordinator.pendingRequests()).toEqual([]);
      await expect(start(fake)).rejects.toMatchObject({ code: "CODEX_COORDINATOR_CLOSED" });
    });
    await withFake(async (fake) => {
      const run = await start(fake);
      fake.store.db.close();
      fake.send!({ method: "item/agentMessage/delta", params: params(run, { delta: "after close" }) });
      await expect.poll(() => fake.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
      await fake.coordinator.close();
    });
  });

  it("recovers exact pre-ack identity when the RPC acknowledgment is lost", async () => {
    await withFake(async (fake) => {
      fake.config.codexTimeoutMs = 40;
      const run = await start(fake);
      expect(run.status).toBe("completed");
      expect(run.metadata).toMatchObject({ codexTurnId: "known-turn", turnAcknowledgmentLost: true });
      expect(run.summary).toBe("Confirmed without ack");
    }, (rpc, send) => {
      if (rpc.method !== "turn/start") return false;
      send({ method: "turn/started", params: { threadId: rpc.params.threadId, turn: { id: "known-turn", status: "inProgress", items: [] } } });
      send({ method: "turn/completed", params: { threadId: rpc.params.threadId, turn: { id: "known-turn", status: "completed", items: [{ type: "agentMessage", id: "answer", text: "Confirmed without ack", phase: "final_answer" }] } } });
      return true;
    });
  });

  it("keeps waiting state for remaining requests and rejects duplicate responses", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      const first = await request(fake, run, "item/commandExecution/requestApproval", { command: "git status" }, "first");
      fake.send!({ id: "second", method: "item/tool/requestUserInput", params: params(run, { questions: [{ id: "q", question: "Details?", options: null }] }) });
      await expect.poll(() => fake.coordinator.pendingRequests().length).toBe(2);
      const respond = fake.coordinator.respond(first.id, { decision: "accept" });
      await expect(fake.coordinator.respond(first.id, { decision: "accept" })).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_FOUND" });
      await respond;
      expect(fake.store.getRun(run.id)?.status).toBe("waiting_input");
      fake.complete();
      await waitStatus(fake, run.id, "completed");
      expect(fake.coordinator.pendingRequests()).toEqual([]);
    });
  });

  it("marks unreadable restart history recovery_required and closes failed reads", async () => {
    await withFake(async (fake) => {
      const run = fake.store.createRun({ workspacePath: fake.root, status: "running", autonomy: "workspace", prompt: "saved", command: "codex-app-thread", metadata: { executionMode: "codex-app-thread", codexThreadId: "saved", codexTurnId: "exact" } });
      await fake.coordinator.reconcile(run.id);
      expect(fake.store.getRun(run.id)?.status).toBe("recovery_required");
      expect(fake.store.getRun(run.id)?.metadata?.recoveryReason).toContain("Unable to read");
      await expect.poll(() => fake.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
      expect(fake.requests.some((rpc) => rpc.method === "turn/start")).toBe(false);
    }, (rpc, send) => {
      if (rpc.method !== "thread/read") return false;
      send({ id: rpc.id, error: { code: -32000, message: "Thread unavailable" } });
      return true;
    });
  });

  it("refuses to steer a server-side active turn and to execute after persistence closes", async () => {
    await withFake(async (fake) => {
      await expect(start(fake)).rejects.toMatchObject({ code: "RUN_CONFLICT" });
      expect(fake.requests.some((rpc) => rpc.method === "turn/start")).toBe(false);
    }, (rpc, send, _socket, fake) => {
      if (rpc.method !== "thread/start") return false;
      send({ id: rpc.id, result: { thread: { id: "active", cwd: fake.root, status: { type: "active", activeFlags: [] }, turns: [] } } });
      return true;
    });
    await withFake(async (fake) => {
      await expect(start(fake)).rejects.toMatchObject({ code: "RUN_STORE_UNAVAILABLE" });
      expect(fake.requests.some((rpc) => rpc.method === "turn/start")).toBe(false);
    }, (rpc, send, _socket, fake) => {
      if (rpc.method !== "thread/start") return false;
      fake.store.db.close();
      send({ id: rpc.id, result: { thread: { id: "not-persisted", cwd: fake.root, status: { type: "idle" }, turns: [] } } });
      return true;
    });
  });

  it("refuses approval replies if persistence has closed", async () => {
    await withFake(async (fake) => {
      const run = await start(fake);
      const pending = await request(fake, run, "item/commandExecution/requestApproval", { command: "git status" });
      fake.store.db.close();
      await expect(fake.coordinator.respond(pending.id, { decision: "accept" })).rejects.toMatchObject({ code: "RUN_STORE_UNAVAILABLE" });
      expect(fake.coordinator.pendingRequests()).toEqual([]);
      expect(fake.requests.some((rpc) => rpc.id === "approval" && rpc.result)).toBe(false);
    });
  });

  it("respects output byte limits for multibyte assistant text", async () => {
    await withFake(async (fake) => {
      fake.config.maxCommandOutputBytes = 10;
      const run = await start(fake);
      fake.complete("completed", [{ type: "agentMessage", id: "utf8", text: "中文中文中文", phase: "final_answer" }]);
      await waitStatus(fake, run.id, "completed");
      const finished = fake.store.getRun(run.id)!;
      expect(Buffer.byteLength(finished.stdout)).toBeLessThanOrEqual(10);
      expect(Buffer.byteLength(finished.summary!)).toBeLessThanOrEqual(10);
      expect(finished.stdout).not.toContain("�");
    });
  });

  it("returns a RunStore-scoped WeakMap singleton", async () => {
    await withFake(async (fake) => {
      const first = getRunCoordinator(fake.config, fake.store);
      expect(getRunCoordinator({ ...fake.config }, fake.store)).toBe(first);
      await first.close();
    });
  });
});
