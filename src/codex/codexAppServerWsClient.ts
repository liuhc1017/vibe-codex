import WebSocket from "ws";
import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexAppServerWsEvent {
  receivedAt: string;
  message: unknown;
}

export interface CodexThreadTurnResult {
  threadId: string;
  turnId?: string;
  threadResponse?: unknown;
  turnResponse?: unknown;
  events: CodexAppServerWsEvent[];
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerWsHooks {
  onNotification?: (method: string, params: Record<string, unknown>, event: CodexAppServerWsEvent) => void;
  onServerRequest?: (request: CodexServerRequest, event: CodexAppServerWsEvent) => void | Promise<void>;
  onDisconnect?: (error: Error) => void;
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function toWsUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL must use ws, wss, http, or https.", { url: rawUrl });
  }
  return parsed.toString();
}

export function extractThreadId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  if (typeof record.threadId === "string") return record.threadId;
  if (typeof record.thread_id === "string") return record.thread_id;
  const thread = record.thread;
  if (typeof thread === "object" && thread !== null) {
    const threadRecord = thread as Record<string, unknown>;
    if (typeof threadRecord.id === "string") return threadRecord.id;
    if (typeof threadRecord.threadId === "string") return threadRecord.threadId;
    if (typeof threadRecord.thread_id === "string") return threadRecord.thread_id;
  }
  return undefined;
}

export function extractTurnId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  if (typeof record.turnId === "string") return record.turnId;
  if (typeof record.turn_id === "string") return record.turn_id;
  const turn = record.turn;
  if (typeof turn === "object" && turn !== null) {
    const turnRecord = turn as Record<string, unknown>;
    if (typeof turnRecord.id === "string") return turnRecord.id;
  }
  return undefined;
}

function turnStartError(error: unknown, args: { threadId: string; threadResponse: unknown; events: CodexAppServerWsEvent[] }): VibeError {
  const details = {
    ...(error instanceof VibeError ? error.details : {}),
    codexThreadId: args.threadId,
    threadId: args.threadId,
    threadResponse: args.threadResponse,
    events: args.events,
    turnStartFailed: true,
  };
  if (error instanceof VibeError) {
    return new VibeError(error.code, error.message, details);
  }
  return new VibeError("CODEX_APP_SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), details);
}

export class CodexAppServerWsClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly hooks: CodexAppServerWsHooks;
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private disconnected = false;
  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  private readonly serverRequests = new Set<string | number>();
  private readonly events: CodexAppServerWsEvent[] = [];

  constructor(args: { url: string; timeoutMs?: number } & CodexAppServerWsHooks) {
    this.url = toWsUrl(args.url);
    this.timeoutMs = args.timeoutMs ?? 30_000;
    this.hooks = args;
  }

  recentEvents(limit = 100): CodexAppServerWsEvent[] {
    const count = Math.max(0, Math.min(200, Math.floor(limit)));
    return count ? this.events.slice(-count) : [];
  }

  async connect(): Promise<void> {
    if (this.closed || this.disconnected) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server client is closed; create a new connection.", {});
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 16 * 1024 * 1024 });
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Timed out connecting to Codex app-server WebSocket.", { url: this.url }));
      }, this.timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        if (this.closed) { ws.close(); return reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server client closed while connecting.", {})); }
        opened = true;
        resolve();
      });
      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", () => {
        clearTimeout(timer);
        const error = new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server WebSocket closed.", { url: this.url });
        if (!opened) reject(error);
        this.handleDisconnect(error);
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        if (!opened) reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Failed to connect to Codex app-server WebSocket.", { url: this.url, error: error.message }));
        this.handleDisconnect(error);
      });
    });
    return this.connecting;
  }

  async initialize(): Promise<unknown> {
    const response = await this.request("initialize", {
      clientInfo: { name: "vibe-codex", version: "0.3.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
    return response;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server WebSocket is not open.", { url: this.url });
    }
    const id = this.nextId++;
    const payload = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", `Timed out waiting for app-server method ${method}.`, { method, url: this.url, events: this.recentEvents(20) }));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params };
    ws.send(JSON.stringify(payload));
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    return this.sendServerResponse(id, { result });
  }

  async refuse(id: string | number, message = "This app-server request is not supported by Vibe Codex.", code = -32601): Promise<void> {
    return this.sendServerResponse(id, { error: { code, message } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws?.close();
    this.serverRequests.clear();
    this.rejectAll(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server WebSocket client closed.", { url: this.url }));
  }

  private async sendServerResponse(id: string | number, response: { result: unknown } | { error: JsonRpcErrorObject }): Promise<void> {
    if (!this.serverRequests.has(id)) throw new VibeError("CODEX_REQUEST_NOT_FOUND", "App-server request is no longer pending.", { id });
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closed || this.disconnected) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Cannot reply on a disconnected app-server connection.", {});
    const payload = JSON.stringify({ jsonrpc: "2.0", id, ...response });
    this.serverRequests.delete(id);
    await new Promise<void>((resolve, reject) => ws.send(payload, (error) => error ? reject(error) : resolve()));
  }

  private remember(message: unknown): CodexAppServerWsEvent {
    const serialized = JSON.stringify(message);
    const event = { receivedAt: new Date().toISOString(), message: serialized.length > 16_384
      ? { truncated: true, preview: serialized.slice(0, 16_384) }
      : message };
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    return event;
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      this.remember({ invalidJson: data.toString("utf8").slice(0, 16_384) });
      return;
    }
    const event = this.remember(message);
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined;
    // Server requests and outbound responses have independent id spaces. Method
    // classification MUST happen first, even if the server reuses a pending id.
    if (typeof record.method === "string") {
      const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
        ? record.params as Record<string, unknown> : {};
      if (id === undefined) {
        if (record.method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) this.serverRequests.delete(params.requestId);
        try { this.hooks.onNotification?.(record.method, params, event); } catch { /* consumer must not crash the transport */ }
        return;
      }
      if (this.serverRequests.has(id)) return;
      this.serverRequests.add(id);
      if (this.serverRequests.size > 100 || !this.hooks.onServerRequest) {
        void this.refuse(id).catch(() => undefined);
        return;
      }
      try {
        Promise.resolve(this.hooks.onServerRequest({ id, method: record.method, params }, event)).catch(() => {
          if (this.serverRequests.has(id)) void this.refuse(id, "App-server request handler failed safely.", -32603).catch(() => undefined);
        });
      } catch {
        void this.refuse(id, "App-server request handler failed safely.", -32603).catch(() => undefined);
      }
      return;
    }
    if (id === undefined || !this.pending.has(id) || !("result" in record || "error" in record)) return;
    const pending = this.pending.get(id)!;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.error) {
      const rpcError = record.error as JsonRpcErrorObject;
      pending.reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", `Codex app-server method ${pending.method} failed: ${rpcError.message ?? "unknown error"}`, {
        method: pending.method,
        code: rpcError.code,
        data: rpcError.data,
        rpcRejected: true,
      }));
      return;
    }
    pending.resolve(record.result);
  }

  private handleDisconnect(error: Error): void {
    this.rejectAll(error);
    this.serverRequests.clear();
    if (this.closed || this.disconnected) return;
    this.disconnected = true;
    try { this.hooks.onDisconnect?.(error); } catch { /* shutdown/closed databases must not escape event callbacks */ }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export async function withCodexAppServerWsClient<T>(args: { url: string; config: Config; fn: (client: CodexAppServerWsClient) => Promise<T> }): Promise<T> {
  const client = new CodexAppServerWsClient({ url: args.url, timeoutMs: Math.min(args.config.codexTimeoutMs, 120_000) });
  try {
    await client.connect();
    await client.initialize();
    return await args.fn(client);
  } finally {
    client.close();
  }
}

export function threadStartParams(args: { workspacePath: string; config: Config }) {
  return {
    ...(args.config.codexModel ? { model: args.config.codexModel } : {}),
    cwd: args.workspacePath,
    runtimeWorkspaceRoots: [args.workspacePath],
    approvalPolicy: args.config.defaultCodexApproval,
    sandbox: args.config.defaultCodexSandbox,
    ephemeral: false,
    sessionStartSource: "startup",
    threadSource: "user",
    serviceName: "vibe-codex",
  };
}

export function turnStartParams(args: { threadId: string; workspacePath: string; prompt: string; config: Config }) {
  return {
    ...(args.config.codexModel ? { model: args.config.codexModel } : {}),
    threadId: args.threadId,
    input: [{ type: "text", text: args.prompt, text_elements: [] }],
    cwd: args.workspacePath,
    runtimeWorkspaceRoots: [args.workspacePath],
    approvalPolicy: args.config.defaultCodexApproval,
  };
}

export async function startCodexAppThreadWs(args: { workspacePath: string; prompt: string; config: Config }) {
  if (!args.config.codexAppServerUrl) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  }
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: async (client) => {
      const threadResponse = await client.request("thread/start", threadStartParams(args));
      const threadId = extractThreadId(threadResponse);
      if (!threadId) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "thread/start response did not include a thread id.", { threadResponse, events: client.recentEvents() });
      let turnResponse: unknown;
      try {
        turnResponse = await client.request("turn/start", turnStartParams({ ...args, threadId }));
      } catch (error) {
        throw turnStartError(error, { threadId, threadResponse, events: client.recentEvents() });
      }
      return { threadId, turnId: extractTurnId(turnResponse), threadResponse, turnResponse, events: client.recentEvents() } satisfies CodexThreadTurnResult;
    },
  });
}

export async function resumeCodexAppThreadWs(args: { threadId: string; workspacePath: string; prompt?: string; config: Config }) {
  if (!args.config.codexAppServerUrl) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  }
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: async (client) => {
      const threadResponse = await client.request("thread/resume", {
        ...(args.config.codexModel ? { model: args.config.codexModel } : {}),
        threadId: args.threadId,
        cwd: args.workspacePath,
        runtimeWorkspaceRoots: [args.workspacePath],
        approvalPolicy: args.config.defaultCodexApproval,
        sandbox: args.config.defaultCodexSandbox,
        persistExtendedHistory: false,
      });
      const threadId = extractThreadId(threadResponse) ?? args.threadId;
      let turnResponse: unknown;
      if (args.prompt) {
        try {
          turnResponse = await client.request("turn/start", turnStartParams({ threadId, workspacePath: args.workspacePath, prompt: args.prompt, config: args.config }));
        } catch (error) {
          throw turnStartError(error, { threadId, threadResponse, events: client.recentEvents() });
        }
      }
      return { threadId, turnId: extractTurnId(turnResponse), threadResponse, turnResponse, events: client.recentEvents() } satisfies CodexThreadTurnResult;
    },
  });
}

export async function continueCodexAppThreadWs(args: { threadId: string; instruction: string; workspacePath: string; config: Config }) {
  return resumeCodexAppThreadWs({ threadId: args.threadId, workspacePath: args.workspacePath, prompt: args.instruction, config: args.config });
}

export async function forkCodexAppThreadWs(args: { threadId: string; workspacePath: string; instruction?: string; config: Config }) {
  if (!args.config.codexAppServerUrl) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  }
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: async (client) => {
      const threadResponse = await client.request("thread/fork", {
        ...(args.config.codexModel ? { model: args.config.codexModel } : {}),
        threadId: args.threadId,
        cwd: args.workspacePath,
        runtimeWorkspaceRoots: [args.workspacePath],
        approvalPolicy: args.config.defaultCodexApproval,
        sandbox: args.config.defaultCodexSandbox,
        ephemeral: false,
        threadSource: "user",
      });
      const threadId = extractThreadId(threadResponse);
      if (!threadId) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "thread/fork response did not include a thread id.", { threadResponse, events: client.recentEvents() });
      let turnResponse: unknown;
      if (args.instruction) {
        try {
          turnResponse = await client.request("turn/start", turnStartParams({ threadId, workspacePath: args.workspacePath, prompt: args.instruction, config: args.config }));
        } catch (error) {
          throw turnStartError(error, { threadId, threadResponse, events: client.recentEvents() });
        }
      }
      return { threadId, turnId: extractTurnId(turnResponse), threadResponse, turnResponse, events: client.recentEvents() } satisfies CodexThreadTurnResult;
    },
  });
}

export async function listCodexThreadsWs(args: { config: Config; cwd?: string }) {
  if (!args.config.codexAppServerUrl) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: (client) => client.request("thread/list", { cwd: args.cwd ?? null, archived: false, limit: 50 }),
  });
}

export async function getCodexAppThreadStatusWs(args: { threadId: string; config: Config }) {
  if (!args.config.codexAppServerUrl) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: (client) => client.request("thread/read", { threadId: args.threadId, includeTurns: true }),
  });
}
