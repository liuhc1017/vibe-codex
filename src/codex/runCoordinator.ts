import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AutonomyLevel, Config } from "../config/types.js";
import { RunStore } from "../runs/runStore.js";
import { RunRecord, RunStatus } from "../runs/types.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { VibeError } from "../util/errors.js";
import { gitIsRepository, gitStatus } from "../workspace/git.js";
import { configWithManagedAppServerUrl, ensureCodexAppServer } from "./codexAppServerManager.js";
import {
  CodexAppServerWsClient, CodexAppServerWsEvent, CodexServerRequest,
  extractThreadId, extractTurnId, threadStartParams, turnStartParams,
} from "./codexAppServerWsClient.js";

export interface StartRunOptions {
  workspacePath: string;
  prompt: string | ((runId: string) => string);
  autonomy: AutonomyLevel;
  projectId?: string;
  threadId?: string;
  fork?: boolean;
  parentRunId?: string;
  setDefaultThread?: boolean;
}

export interface PendingRunRequest {
  id: string;
  runId: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: string;
}

type Incoming = { method: string; params: Record<string, unknown>; event: CodexAppServerWsEvent; request?: CodexServerRequest; afterTurnSubmit?: boolean };
type Session = {
  run: RunRecord;
  client?: CodexAppServerWsClient;
  starting: boolean;
  turnSent: boolean;
  disconnected: boolean;
  disposed: boolean;
  incoming: Incoming[];
  locks: Set<string>;
  timer?: NodeJS.Timeout;
  terminalWaiters?: Set<() => void>;
  assistant: Map<string, string>;
  commands: Map<string, string>;
  finalAnswer?: string;
};
type StoredRequest = PendingRunRequest & { rpcId: string | number; session: Session; responding?: boolean };

const activeStatuses = new Set<RunStatus>(["queued", "running", "waiting_approval", "waiting_input", "recovering", "recovery_required"]);
const terminalStatuses = new Set<RunStatus>(["completed", "failed", "interrupted"]);
const approvalMethods = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
const inputMethod = "item/tool/requestUserInput";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes ? value : bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/�$/, "");
}
function statusOf(turn: Record<string, unknown>): RunStatus | undefined {
  switch (turn.status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "inProgress": case "running": return "running";
    default: return undefined;
  }
}
function bounded(value: unknown, max = 8_192): unknown {
  const serialized = JSON.stringify(value);
  return serialized && serialized.length > max ? { truncated: true, preview: serialized.slice(0, max) } : value;
}

/** One retained connection per active turn; history is evidence, never a replay queue. */
export class RunCoordinator {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Set<string>();
  private readonly requests = new Map<string, StoredRequest>();
  private readonly reads = new Set<CodexAppServerWsClient>();
  private readonly reconciliations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly config: Config, private readonly runStore: RunStore) {}

  async start(args: StartRunOptions): Promise<RunRecord> {
    this.assertOpen();
    if (args.autonomy === "manual") throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex tasks.", {});
    if (args.fork && !args.threadId) throw new VibeError("INVALID_ARGUMENT", "Forking requires a source thread id.", {});
    const keys = new Set([`workspace:${path.resolve(args.workspacePath.replace(/^~(?=$|[/\\])/, os.homedir()))}`]);
    if (args.threadId) keys.add(`thread:${args.threadId}`);
    // Reserve before the first await, including the source thread of a fork.
    this.acquire(keys);
    let session: Session | undefined;
    try {
      const workspacePath = await assertSafeWorkspacePath(args.workspacePath, this.config);
      this.assertOpen();
      const canonicalKey = `workspace:${workspacePath}`;
      if (!keys.has(canonicalKey)) { this.acquire(new Set([canonicalKey])); keys.add(canonicalKey); }
      this.assertNoPersistedActive(workspacePath, args.threadId);
      if (!(await gitIsRepository(workspacePath, this.config))) throw new VibeError("NOT_A_GIT_REPOSITORY", "Codex tasks require an allowed Git workspace.", { workspacePath });
      this.assertOpen();
      const project = args.projectId ? this.runStore.getProject(args.projectId) : undefined;
      if (args.projectId && !project) throw new VibeError("PROJECT_NOT_FOUND", "Project not found.", { projectId: args.projectId });
      if (project && await assertSafeWorkspacePath(project.path, this.config) !== workspacePath) throw new VibeError("INVALID_ARGUMENT", "Project and workspace paths do not match.", {});
      const baseline = await gitStatus(workspacePath, this.config);
      this.assertOpen();
      this.assertNoPersistedActive(workspacePath, args.threadId);
      const parentRunId = args.parentRunId ?? (args.threadId ? this.runStore.listRuns().find((run) => run.metadata?.codexThreadId === args.threadId)?.id : undefined);
      const run = this.runStore.createRun({
        projectId: args.projectId, workspacePath, status: "queued", autonomy: args.autonomy,
        prompt: typeof args.prompt === "string" ? args.prompt : "", command: "codex-app-thread",
        metadata: { executionMode: "codex-app-thread", projectId: args.projectId, parentRunId,
          sourceCodexThreadId: args.fork ? args.threadId : undefined, codexThreadId: args.fork ? undefined : args.threadId,
          operation: args.fork ? "fork" : args.threadId ? "continue" : "start", baselineGitStatus: baseline.stdout,
          promptSubmittedAutomatically: false, usesCodexExec: false, requiresManualPaste: false },
      });
      session = { run, starting: true, turnSent: false, disconnected: false, disposed: false,
        incoming: [], locks: keys, assistant: new Map(), commands: new Map() };
      this.sessions.set(run.id, session);
      const prompt = typeof args.prompt === "function" ? args.prompt(run.id) : args.prompt;
      if (!prompt.trim()) throw new VibeError("INVALID_ARGUMENT", "Codex prompt must not be empty.", { runId: run.id });
      this.patch(session, { prompt });
      this.assertSessionAlive(session);
      const managedConfig = configWithManagedAppServerUrl(this.config, await ensureCodexAppServer(this.config));
      this.assertSessionAlive(session);
      const safeConfig = { ...managedConfig, defaultCodexApproval: this.config.defaultCodexApproval === "untrusted" ? "untrusted" : "on-request", defaultCodexSandbox: "workspace-write" };
      const live = session;
      const client = new CodexAppServerWsClient({
        url: safeConfig.codexAppServerUrl!, timeoutMs: this.rpcTimeout(),
        onNotification: (method, params, event) => this.receive(live, { method, params, event }),
        onServerRequest: (request, event) => this.receive(live, { ...request, event, request }),
        onDisconnect: (error) => this.disconnected(live, error),
      });
      session.client = client;
      await client.connect();
      await client.initialize();
      this.assertSessionAlive(session);
      if (args.threadId) {
        // Read before resume/fork: resume can replace cwd and conceal an origin
        // in an ungranted project. Never import that thread's context blindly.
        const sourceResponse = await client.request("thread/read", { threadId: args.threadId, includeTurns: false });
        const source = record(record(sourceResponse)?.thread);
        const sourceCwd = text(source?.cwd);
        if (source?.id !== args.threadId || !sourceCwd || await assertSafeWorkspacePath(sourceCwd, this.config).catch(() => undefined) !== workspacePath) {
          throw new VibeError("THREAD_WORKSPACE_MISMATCH", "The source thread does not belong to this granted workspace.", { threadId: args.threadId });
        }
      }
      this.assertSessionAlive(session);
      const threadResponse = args.threadId
        ? await client.request(args.fork ? "thread/fork" : "thread/resume", {
          ...threadStartParams({ workspacePath, config: safeConfig }), threadId: args.threadId,
          ...(args.fork ? {} : { persistExtendedHistory: false }),
        })
        : await client.request("thread/start", threadStartParams({ workspacePath, config: safeConfig }));
      this.assertSessionAlive(session);
      const threadId = extractThreadId(threadResponse) ?? (args.fork ? undefined : args.threadId);
      if (!threadId) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Thread response did not include a thread id.", {});
      if (args.threadId && (args.fork ? threadId === args.threadId : threadId !== args.threadId)) {
        throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Thread identity did not match the requested resume/fork operation.", { threadId });
      }
      const threadKey = `thread:${threadId}`;
      if (!keys.has(threadKey)) { this.acquire(new Set([threadKey])); keys.add(threadKey); }
      this.patch(session, {}, { codexThreadId: threadId, threadResponse: bounded(threadResponse) });
      const returnedThread = record(record(threadResponse)?.thread);
      if (args.threadId && (!text(returnedThread?.cwd) || await assertSafeWorkspacePath(returnedThread!.cwd as string, this.config).catch(() => undefined) !== workspacePath)) {
        throw new VibeError("THREAD_WORKSPACE_MISMATCH", "Resumed/forked thread does not match this granted workspace.", { threadId });
      }
      this.assertSessionAlive(session);
      this.mapProjectThread(session.run, args.setDefaultThread ?? true);
      if (record(returnedThread?.status)?.type === "active" || Array.isArray(returnedThread?.turns) && returnedThread.turns.some((value) => record(value)?.status === "inProgress")) {
        throw new VibeError("RUN_CONFLICT", "The Codex thread already has an active turn; refusing to steer or replay it.", { threadId });
      }
      session.turnSent = true;
      this.patch(session, {}, { turnStartSubmitted: true });
      const turnResponse = await client.request("turn/start", {
        ...turnStartParams({ threadId, workspacePath, prompt, config: safeConfig }),
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspacePath], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      });
      const turnId = extractTurnId(turnResponse);
      if (!turnId) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Turn acknowledgment did not include an exact turn id; execution may have started.", {});
      this.patch(session, { status: "running" }, { codexTurnId: turnId, turnResponse: bounded(turnResponse), promptSubmittedAutomatically: true });
      session.starting = false;
      // Replay only local, already-received events after establishing exact identity.
      for (const incoming of session.incoming.splice(0)) this.process(session, incoming);
      if (!session.disposed) this.applyTurn(session, record(record(turnResponse)?.turn));
      if (!session.disposed && session.disconnected) await this.reconcileSession(session, "Connection lost before the turn acknowledgment was processed.");
      if (!session.disposed) {
        session.timer = setTimeout(() => { void this.timeout(live).catch(() => this.recoveryRequired(live, "Turn timeout recovery failed.")); }, Math.max(1, this.config.codexTimeoutMs));
        session.timer.unref();
      }
      return this.runStore.getRun(run.id) ?? session.run;
    } catch (error) {
      if (session && !session.disposed) {
        session.starting = false;
        const rejected = error instanceof VibeError && error.details.rpcRejected === true;
        if (session.turnSent && !rejected) {
          const ids = new Set(session.incoming.filter((incoming) => incoming.afterTurnSubmit && (incoming.method === "turn/started" || incoming.method === "turn/completed") && incoming.params.threadId === session!.run.metadata?.codexThreadId)
            .map((incoming) => text(record(incoming.params.turn)?.id)).filter((id): id is string => !!id));
          if (ids.size === 1) {
            this.patch(session, {}, { codexTurnId: [...ids][0], turnAcknowledgmentLost: true });
            for (const incoming of session.incoming.splice(0)) this.process(session, incoming);
            if (session.disposed && terminalStatuses.has(session.run.status)) return this.runStore.getRun(session.run.id) ?? session.run;
          }
        }
        const uncertain = session.turnSent && !rejected;
        this.patch(session, { status: uncertain ? "recovery_required" : "failed", stderr: errorText(error), exitCode: uncertain ? null : 1 }, {
          appServerError: { message: errorText(error), ...(error instanceof VibeError ? { code: error.code, details: bounded(error.details) } : {}) },
          turnStartFailed: true, pendingRequests: [], recoveryReason: uncertain ? "The start result is uncertain. Read the exact turn; do not replay automatically." : undefined,
        });
        this.dispose(session);
        if (error instanceof VibeError) throw new VibeError(error.code, error.message, { ...error.details, runId: session.run.id, codexThreadId: session.run.metadata?.codexThreadId, turnStartFailed: session.turnSent });
        throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", errorText(error), { runId: session.run.id, codexThreadId: session.run.metadata?.codexThreadId });
      }
      throw error;
    } finally {
      if (!session) for (const key of keys) this.locks.delete(key);
    }
  }

  pendingRequests(): PendingRunRequest[] {
    return [...this.requests.values()].map(({ id, runId, method, params, createdAt }) => ({ id, runId, method, params: structuredClone(params), createdAt }));
  }

  async respond(requestId: string, result: unknown): Promise<void> {
    this.assertOpen();
    const pending = this.requests.get(requestId);
    if (!pending || pending.session.disposed || pending.responding) throw new VibeError("CODEX_REQUEST_NOT_FOUND", "This request is no longer pending.", { requestId });
    this.assertSessionAlive(pending.session);
    const response = this.validateResponse(pending, result);
    pending.responding = true;
    try {
      await pending.session.client!.respond(pending.rpcId, response);
      this.requests.delete(requestId);
      if (!pending.session.disposed) this.refreshWaiting(pending.session);
    } catch (error) {
      pending.responding = false;
      this.requests.delete(requestId);
      this.disconnected(pending.session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async interrupt(runId: string): Promise<RunRecord> {
    this.assertOpen();
    const run = this.runStore.getRun(runId);
    if (!run) throw new VibeError("RUN_NOT_FOUND", "Run not found.", { runId });
    if (terminalStatuses.has(run.status)) return run;
    const session = this.sessions.get(runId);
    const threadId = text(run.metadata?.codexThreadId);
    const turnId = text(run.metadata?.codexTurnId);
    if (!threadId || !turnId) {
      if (session?.starting) throw new VibeError("RUN_NOT_READY", "Wait for an exact turn acknowledgment before interrupting.", { runId });
      this.safeUpdate(run, { status: "recovery_required" }, { recoveryReason: "No exact thread/turn id is available for a safe interrupt." });
      return this.runStore.getRun(runId)!;
    }
    try {
      if (session?.client && !session.disconnected) {
        this.patch(session, { status: "recovering" }, { interruptRequested: true });
        await this.requestInterrupt(session, threadId, turnId);
        await this.waitForTerminal(session);
      } else {
        this.safeUpdate(run, { status: "recovering" }, { interruptRequested: true });
        await this.withReader((client) => client.request("turn/interrupt", { threadId, turnId }));
      }
      await this.reconcile(runId);
    } catch (error) {
      if (session && !session.disposed) this.recoveryRequired(session, `Interrupt could not be confirmed: ${errorText(error)}`);
      else {
        const current = this.runStore.getRun(runId)!;
        if (!terminalStatuses.has(current.status)) this.safeUpdate(current, { status: "recovery_required" }, { recoveryReason: `Interrupt could not be confirmed: ${errorText(error)}` });
      }
    }
    return this.runStore.getRun(runId)!;
  }

  async reconcile(runId?: string): Promise<void> {
    this.assertOpen();
    const runs = runId ? [this.runStore.getRun(runId)].filter((run): run is RunRecord => !!run) : this.runStore.listRuns();
    if (runId && !runs.length) throw new VibeError("RUN_NOT_FOUND", "Run not found.", { runId });
    for (const run of runs) {
      if (run.metadata?.executionMode !== "codex-app-thread" || !activeStatuses.has(run.status)) continue;
      const existing = this.reconciliations.get(run.id);
      if (existing) { await existing; continue; }
      const task = this.reconcileRun(run);
      this.reconciliations.set(run.id, task);
      try { await task; } finally { this.reconciliations.delete(run.id); }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      this.patch(session, { status: "recovery_required" }, { recoveryReason: "Relay closed before execution was confirmed terminal; reconcile before continuing." });
      this.dispose(session);
    }
    for (const client of this.reads) client.close();
    this.reads.clear();
    this.requests.clear();
    await Promise.allSettled([...this.reconciliations.values()]);
  }

  private receive(session: Session, incoming: Incoming): void {
    if (session.disposed || this.closed) {
      if (incoming.request) void session.client?.refuse(incoming.request.id, "The run is no longer supervised.").catch(() => undefined);
      return;
    }
    if (incoming.request && !approvalMethods.has(incoming.method) && incoming.method !== inputMethod) {
      void session.client?.refuse(incoming.request.id, "Unsupported privileged app-server request; no permissions were granted.").catch(() => undefined);
      this.event(session, incoming);
      return;
    }
    if (session.starting) {
      const bufferedBytes = session.incoming.reduce((sum, event) => sum + JSON.stringify(event.params).length, 0);
      if (session.incoming.length >= 200 || bufferedBytes + JSON.stringify(incoming.params).length > 2_000_000) {
        // Dropping a terminal event is unsafe: make the entire start uncertain.
        session.disconnected = true;
        session.client?.close();
        return;
      }
      session.incoming.push({ ...incoming, afterTurnSubmit: session.turnSent });
      return;
    }
    this.process(session, incoming);
  }

  private process(session: Session, incoming: Incoming): void {
    if (session.disposed || this.closed) return;
    const { method, params, request } = incoming;
    const threadId = text(params.threadId);
    const turn = record(params.turn);
    const turnId = text(params.turnId) ?? text(turn?.id);
    if (threadId !== session.run.metadata?.codexThreadId || (turnId && turnId !== session.run.metadata?.codexTurnId)) {
      if (request) void session.client?.refuse(request.id, "Request does not belong to this exact run.", -32602).catch(() => undefined);
      return;
    }
    if (request && !turnId) { void session.client?.refuse(request.id, "Request has no exact turn id.", -32602).catch(() => undefined); return; }
    this.event(session, incoming);
    if (request) {
      if (!this.supportedRequest(request)) {
        void session.client?.refuse(request.id, "Unsupported approval expansion or malformed request; no permissions were granted.", -32602).catch(() => undefined);
        return;
      }
      const id = randomUUID();
      this.requests.set(id, { id, runId: session.run.id, method, params: structuredClone(params), createdAt: incoming.event.receivedAt, rpcId: request.id, session });
      this.refreshWaiting(session);
      return;
    }
    if (method === "serverRequest/resolved") {
      for (const [id, pending] of this.requests) if (pending.session === session && pending.rpcId === params.requestId) this.requests.delete(id);
      this.refreshWaiting(session);
    } else if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.append(session.assistant, text(params.itemId) ?? "assistant", params.delta);
      this.persistOutput(session);
    } else if ((method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") && typeof params.delta === "string") {
      this.append(session.commands, text(params.itemId) ?? "command", params.delta);
      this.persistOutput(session);
    } else if (method === "item/completed" || method === "item/started") {
      const item = record(params.item);
      if (item) this.applyItem(session, item, method === "item/completed");
    } else if (method === "turn/completed" || method === "turn/started") {
      this.applyTurn(session, turn);
    } else if (method === "error") {
      const message = text(record(params.error)?.message) ?? "Codex turn error.";
      this.patch(session, { stderr: this.limit(session.run.stderr + (session.run.stderr ? "\n" : "") + message) }, { lastError: bounded(params.error), willRetry: params.willRetry === true });
      if (params.willRetry === false) this.finish(session, "failed");
    } else if (method === "turn/plan/updated" || method === "turn/diff/updated") {
      this.patch(session, {}, { [method === "turn/plan/updated" ? "codexPlan" : "codexDiff"]: bounded(params) });
    }
  }

  private applyItem(session: Session, item: Record<string, unknown>, completed: boolean): void {
    const id = text(item.id);
    if (!id) return;
    const items = Array.isArray(session.run.metadata?.codexItems) ? session.run.metadata.codexItems as Record<string, unknown>[] : [];
    this.patch(session, {}, { codexItems: [...items.filter((entry) => entry.id !== id), { id, type: item.type, status: item.status, ...record(bounded(item, 4_096)) }].slice(-50) });
    if (item.type === "agentMessage" && typeof item.text === "string" && (completed || !session.assistant.has(id))) {
      this.setOutput(session.assistant, id, item.text);
      if (item.phase === "final_answer") session.finalAnswer = this.limit(item.text);
    }
    if (item.type === "commandExecution" && typeof item.aggregatedOutput === "string" && completed) this.setOutput(session.commands, id, item.aggregatedOutput);
    this.persistOutput(session);
  }

  private applyTurn(session: Session, turn: Record<string, unknown> | undefined): void {
    if (!turn || session.disposed || turn.id !== session.run.metadata?.codexTurnId) return;
    if (Array.isArray(turn.items)) for (const value of turn.items) { const item = record(value); if (item) this.applyItem(session, item, true); }
    const status = statusOf(turn);
    this.patch(session, {}, { codexTurnStatus: turn.status });
    if (status && terminalStatuses.has(status)) {
      const message = text(record(turn.error)?.message);
      if (message) this.patch(session, { stderr: this.limit(session.run.stderr + (session.run.stderr ? "\n" : "") + message) }, { lastError: bounded(turn.error) });
      this.finish(session, status);
    }
    // A late inProgress acknowledgment must not erase waiting or terminal state.
  }

  private finish(session: Session, status: RunStatus): void {
    if (session.disposed) return;
    this.persistOutput(session);
    const summary = session.finalAnswer ?? [...session.assistant.values()].at(-1) ?? (status === "completed" ? "Codex turn completed." : status === "interrupted" ? "Codex turn interrupted." : "Codex turn failed.");
    this.patch(session, { status, summary: this.limit(summary), exitCode: status === "completed" ? 0 : status === "failed" ? 1 : null }, {
      summary: this.limit(summary), appServerSummary: this.limit(summary), completedAt: new Date().toISOString(), pendingRequests: [],
    });
    this.dispose(session);
  }

  private supportedRequest(request: CodexServerRequest): boolean {
    const p = request.params;
    if (!text(p.itemId) || JSON.stringify(p).length > 65_536) return false;
    if (request.method === inputMethod) {
      if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > 20) return false;
      const ids = new Set<string>();
      return p.questions.every((value) => {
        const question = record(value);
        const id = text(question?.id);
        if (!question || !id || ids.has(id) || typeof question.question !== "string" || question.isSecret === true) return false;
        ids.add(id);
        return question.options == null || Array.isArray(question.options) && question.options.length <= 100 && question.options.every((option) => typeof record(option)?.label === "string");
      });
    }
    // No session grants, sandbox/network expansions, environment selection, or
    // persistent policy changes can be authorized through this response path.
    for (const key of ["additionalPermissions", "grantRoot", "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "environmentId"]) {
      if (p[key] != null && !(Array.isArray(p[key]) && p[key].length === 0)) return false;
    }
    if (p.kind !== undefined && p.kind !== "command") return false;
    return approvalMethods.has(request.method);
  }

  private validateResponse(pending: StoredRequest, result: unknown): Record<string, unknown> {
    const response = record(result);
    const invalid = () => new VibeError("INVALID_CODEX_RESPONSE", "Reply must match this request without granting persistent or expanded permissions.", { requestId: pending.id });
    if (!response) throw invalid();
    if (approvalMethods.has(pending.method)) {
      if (Object.keys(response).length !== 1 || !["accept", "decline", "cancel"].includes(String(response.decision)) || typeof response.decision !== "string") throw invalid();
      const available = pending.params.availableDecisions;
      if (Array.isArray(available) && !available.includes(response.decision)) throw invalid();
      return { decision: response.decision };
    }
    const answers = record(response.answers);
    const questions = pending.params.questions as Record<string, unknown>[];
    if (Object.keys(response).length !== 1 || !answers || Object.keys(answers).length !== questions.length) throw invalid();
    const clean: Record<string, { answers: string[] }> = Object.create(null);
    for (const question of questions) {
      const id = question.id as string;
      const answer = record(answers[id]);
      if (!Object.hasOwn(answers, id) || !answer || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers) || answer.answers.length < 1 || answer.answers.length > 20 || !answer.answers.every((a) => typeof a === "string" && a.length <= 10_000 && a.trim().length > 0)) throw invalid();
      if (Array.isArray(question.options) && question.options.length && question.isOther !== true) {
        const labels = question.options.map((option) => record(option)?.label);
        if (!answer.answers.every((a) => labels.includes(a))) throw invalid();
      }
      clean[id] = { answers: [...answer.answers] as string[] };
    }
    return { answers: clean };
  }

  private refreshWaiting(session: Session): void {
    if (session.disposed) return;
    const pending = [...this.requests.values()].filter((entry) => entry.session === session);
    const status: RunStatus = pending.some((entry) => approvalMethods.has(entry.method)) ? "waiting_approval" : pending.length ? "waiting_input" : "running";
    this.patch(session, { status }, { pendingRequests: pending.map(({ id, method, createdAt }) => ({ id, method, createdAt })) });
  }

  private event(session: Session, incoming: Incoming): void {
    const existing = Array.isArray(session.run.metadata?.appServerEvents) ? session.run.metadata.appServerEvents : [];
    this.patch(session, {}, { appServerEvents: [...existing, { receivedAt: incoming.event.receivedAt, message: bounded({ method: incoming.method, params: incoming.params }, 4_096) }].slice(-100),
      lastProgressAt: incoming.event.receivedAt, lastProgressMethod: incoming.method });
  }

  private append(map: Map<string, string>, id: string, delta: string): void { this.setOutput(map, id, (map.get(id) ?? "") + this.limit(delta)); }
  private setOutput(map: Map<string, string>, id: string, output: string): void {
    if (!map.has(id) && map.size >= 50) return;
    const others = [...map].reduce((total, [key, value]) => total + (key === id ? 0 : Buffer.byteLength(value, "utf8")), 0);
    map.set(id, truncateUtf8(output, Math.max(0, this.outputLimit() - others)));
  }
  private persistOutput(session: Session): void {
    this.patch(session, { stdout: this.limit([...session.assistant.values()].join("\n\n")) }, { commandOutput: this.limit([...session.commands.values()].join("\n\n")),
      ...(session.finalAnswer ? { finalAnswer: session.finalAnswer } : {}) });
  }
  private outputLimit(): number { return Math.max(1, Math.min(this.config.maxCommandOutputBytes, 1_000_000)); }
  private limit(value: string): string { return truncateUtf8(value, this.outputLimit()); }
  private rpcTimeout(): number { return Math.max(1, Math.min(this.config.codexTimeoutMs, 30_000)); }

  private disconnected(session: Session, error: Error): void {
    if (session.disposed || this.closed) return;
    session.disconnected = true;
    if (session.starting) return; // start's catch/ack path owns this race
    this.patch(session, { status: "recovering" }, { recoveryReason: errorText(error), pendingRequests: [] });
    this.clearRequests(session);
    void this.reconcileSession(session, errorText(error)).catch(() => this.recoveryRequired(session, "Disconnected; reconciliation could not establish execution state."));
  }
  private async reconcileSession(session: Session, reason: string): Promise<void> {
    this.patch(session, { status: "recovering" }, { recoveryReason: reason });
    await this.reconcile(session.run.id);
  }
  private async timeout(session: Session): Promise<void> {
    if (session.disposed || this.closed) return;
    this.patch(session, { status: "recovering" }, { timedOut: true, interruptRequested: true, recoveryReason: "Codex turn exceeded its time limit; requesting an exact-turn interrupt." });
    try {
      await this.requestInterrupt(session, session.run.metadata?.codexThreadId as string, session.run.metadata?.codexTurnId as string);
      await this.waitForTerminal(session);
    } catch { /* reconcile instead of claiming failure */ }
    if (!session.disposed) {
      session.disconnected = true; // an unconfirmed timeout must not stay running
      await this.reconcile(session.run.id);
    }
  }

  private async requestInterrupt(session: Session, threadId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + Math.min(2_000, this.rpcTimeout());
    while (!session.disposed) {
      try {
        await session.client!.request("turn/interrupt", { threadId, turnId });
        return;
      } catch (error) {
        if (session.disposed && terminalStatuses.has(session.run.status)) return;
        // turn/start can acknowledge before the engine installs its active turn.
        // Retry only this exact interrupt, never task submission or other errors.
        if (!(error instanceof VibeError) || error.details.rpcRejected !== true
          || !error.message.includes("no active turn to interrupt") || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async waitForTerminal(session: Session): Promise<void> {
    if (session.disposed) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); session.terminalWaiters?.delete(done); resolve(); };
      // The RPC acknowledgment can precede engine cancellation and its terminal
      // notification by seconds. Keep supervision alive during a bounded grace.
      const timer = setTimeout(done, Math.min(5_000, this.rpcTimeout()));
      session.terminalWaiters ??= new Set();
      session.terminalWaiters.add(done);
    });
  }

  private async reconcileRun(original: RunRecord): Promise<void> {
    const session = this.sessions.get(original.id);
    if (session?.starting) return;
    let run = this.runStore.getRun(original.id) ?? original;
    const threadId = text(run.metadata?.codexThreadId);
    let turnId = text(run.metadata?.codexTurnId);
    if (threadId && !turnId) {
      // 0.2 persisted the exact turn acknowledgment inside appServerResponse.
      // Import only mutually consistent saved identities, never infer the latest
      // turn from thread history or resend the original prompt.
      const legacy = record(run.metadata?.appServerResponse);
      const savedTurnId = text(legacy?.turnId);
      if (savedTurnId && legacy?.threadId === threadId
        && extractThreadId(legacy.threadResponse) === threadId
        && extractTurnId(legacy.turnResponse) === savedTurnId) {
        this.safeUpdate(run, {}, { codexTurnId: savedTurnId, legacyTurnIdentityRecovered: true });
        run = this.runStore.getRun(run.id) ?? run;
        turnId = savedTurnId;
      }
    }
    if (!threadId || !turnId) { this.requireRecovery(run, session, "Missing exact thread/turn ids. Execution cannot be safely identified or replayed."); return; }
    if (session) this.patch(session, { status: "recovering" });
    else this.safeUpdate(run, { status: "recovering" });
    try {
      const response = await this.withReader((client) => client.request("thread/read", { threadId, includeTurns: true }));
      if (this.closed || session?.disposed || terminalStatuses.has(this.runStore.getRun(run.id)?.status ?? "queued")) return;
      const thread = record(record(response)?.thread);
      if (thread?.id !== threadId || !Array.isArray(thread.turns)) { this.requireRecovery(run, session, "Thread history did not match the saved thread or include its turns."); return; }
      const turn = thread.turns.map(record).find((candidate) => candidate?.id === turnId);
      if (!turn) { this.requireRecovery(run, session, "The exact saved turn is absent from thread history. No turn was replayed."); return; }
      const status = statusOf(turn);
      if (status && terminalStatuses.has(status)) {
        const recovered: Session = session ?? { run: this.runStore.getRun(run.id) ?? run, starting: false, turnSent: true, disconnected: true, disposed: false, incoming: [], locks: new Set<string>(), assistant: new Map<string, string>(), commands: new Map<string, string>() };
        if (!session) {
          const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
          if (!items.some((item) => item?.type === "agentMessage") && recovered.run.stdout) this.setOutput(recovered.assistant, "saved-output", recovered.run.stdout);
          if (!items.some((item) => item?.type === "commandExecution") && typeof recovered.run.metadata?.commandOutput === "string") this.setOutput(recovered.commands, "saved-command-output", recovered.run.metadata.commandOutput);
          recovered.finalAnswer = text(recovered.run.metadata?.finalAnswer);
        }
        this.applyTurn(recovered, turn);
      } else if (status === "running" && session && !session.disconnected && !run.metadata?.interruptRequested) {
        for (const value of Array.isArray(turn.items) ? turn.items : []) { const item = record(value); if (item) this.applyItem(session, item, true); }
        this.refreshWaiting(session);
      } else {
        this.requireRecovery(run, session, status === "running" ? "The exact turn is still in progress, but live supervision/stop confirmation cannot be recovered. Resolve it locally before continuing; no replay was attempted." : "The saved turn has an unknown status; no replay was attempted.");
      }
    } catch (error) {
      if (!this.closed) this.requireRecovery(run, session, `Unable to read exact turn history: ${errorText(error)}`);
    }
  }

  private async withReader<T>(fn: (client: CodexAppServerWsClient) => Promise<T>): Promise<T> {
    const config = configWithManagedAppServerUrl(this.config, await ensureCodexAppServer(this.config));
    this.assertOpen();
    const client = new CodexAppServerWsClient({ url: config.codexAppServerUrl!, timeoutMs: this.rpcTimeout() });
    this.reads.add(client);
    try { await client.connect(); await client.initialize(); return await fn(client); }
    finally { this.reads.delete(client); client.close(); }
  }
  private requireRecovery(run: RunRecord, session: Session | undefined, reason: string): void {
    if (session) this.recoveryRequired(session, reason);
    else { const current = this.safeGet(run.id); if (current && !terminalStatuses.has(current.status)) this.safeUpdate(current, { status: "recovery_required" }, { recoveryReason: reason, pendingRequests: [] }); }
  }
  private recoveryRequired(session: Session, reason: string): void {
    if (session.disposed) return;
    this.patch(session, { status: "recovery_required" }, { recoveryReason: reason, pendingRequests: [] });
    this.dispose(session);
  }
  private mapProjectThread(run: RunRecord, setDefault: boolean): void {
    const projectId = text(run.metadata?.projectId);
    const threadId = text(run.metadata?.codexThreadId);
    if (!projectId || !threadId) return;
    const project = this.runStore.getProject(projectId);
    if (!project) return;
    this.runStore.updateProject(project.id, { preferredExecutionMode: "codex-app-thread", lastUsedAt: new Date().toISOString(),
      recentCodexThreadIds: [threadId, ...(project.recentCodexThreadIds ?? []).filter((id) => id !== threadId)].slice(0, 20),
      ...(setDefault ? { defaultCodexThreadId: threadId } : {}) });
  }
  private acquire(keys: Set<string>): void {
    for (const key of keys) if (this.locks.has(key)) throw new VibeError("RUN_CONFLICT", "A run already owns this workspace or thread.", { key });
    for (const key of keys) this.locks.add(key);
  }
  private assertNoPersistedActive(workspace: string, threadId?: string): void {
    const active = this.runStore.listRuns().find((run) => run.metadata?.executionMode === "codex-app-thread" && activeStatuses.has(run.status) && (run.workspacePath === workspace || !!threadId && run.metadata?.codexThreadId === threadId));
    if (active) throw new VibeError("RUN_CONFLICT", "An active or uncertain run must be reconciled before another turn can start.", { runId: active.id, status: active.status });
  }
  private clearRequests(session: Session): void { for (const [id, pending] of this.requests) if (pending.session === session) this.requests.delete(id); }
  private dispose(session: Session): void {
    if (session.disposed) return;
    session.disposed = true;
    clearTimeout(session.timer);
    for (const done of session.terminalWaiters ?? []) done();
    session.terminalWaiters?.clear();
    this.clearRequests(session);
    session.incoming = [];
    session.client?.close();
    this.sessions.delete(session.run.id);
    for (const key of session.locks) this.locks.delete(key);
  }
  private patch(session: Session, patch: Partial<RunRecord>, metadata: Record<string, unknown> = {}): void {
    if (session.disposed) return;
    const next = this.safeUpdate(session.run, patch, metadata);
    if (next) {
      session.run = next;
      if (terminalStatuses.has(next.status) && !terminalStatuses.has(patch.status ?? "queued")) this.dispose(session);
    } else this.dispose(session); // database shutdown must not leave callbacks/timers alive
  }
  private safeGet(id: string): RunRecord | null { try { return this.runStore.getRun(id); } catch { return null; } }
  private safeUpdate(run: RunRecord, patch: Partial<RunRecord>, metadata: Record<string, unknown> = {}): RunRecord | undefined {
    try {
      const current = this.runStore.getRun(run.id);
      if (!current) return undefined;
      // Consumers may finish a run independently. Never regress terminal state.
      if (terminalStatuses.has(current.status)) return current;
      return this.runStore.updateRun(run.id, { ...patch, metadata: { ...current.metadata, ...metadata } });
    } catch { return undefined; }
  }
  private assertSessionAlive(session: Session): void {
    this.assertOpen();
    if (session.disposed || !this.safeGet(session.run.id)) {
      this.dispose(session);
      throw new VibeError("RUN_STORE_UNAVAILABLE", "Run persistence is unavailable; refusing further execution.", { runId: session.run.id });
    }
  }
  private assertOpen(): void { if (this.closed) throw new VibeError("CODEX_COORDINATOR_CLOSED", "Run coordinator is closed.", {}); }
}

const coordinators = new WeakMap<RunStore, RunCoordinator>();
export function getRunCoordinator(config: Config, runStore: RunStore): RunCoordinator {
  let coordinator = coordinators.get(runStore);
  if (!coordinator) { coordinator = new RunCoordinator(config, runStore); coordinators.set(runStore, coordinator); }
  return coordinator;
}
