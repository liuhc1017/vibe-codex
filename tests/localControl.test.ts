import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, request as httpRequest, Server } from "node:http";
import { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "../src/config/types.js";
import { createLocalControl, loadOwnerKey } from "../src/server/localControl.js";
import { createHttpApp, listen } from "../src/server/http.js";
import { collectDiagnostics } from "../src/server/diagnostics.js";
import { OAuthStore, pkceS256 } from "../src/server/oauthStore.js";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";
import { getRunCoordinator, RunCoordinator } from "../src/codex/runCoordinator.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { gitInit } from "../src/workspace/git.js";
import { tempConfig } from "./helpers.js";

vi.mock("../src/server/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/diagnostics.js")>();
  return { ...actual, collectDiagnostics: vi.fn(async (config: Config) => ({
    version: "test", status: "ready", checks: [{ name: "Test prerequisites", ok: true, detail: "Deterministic local test." }],
    codex: { available: true, loggedIn: true, executionReady: true }, roots: config.allowedRoots.map((path) => ({ path, exists: true })),
    connector: actual.connectorSettings(config), warnings: [], localControlUrl: `http://127.0.0.1:${config.controlPort}`,
  })) };
});

type OwnerAuth = { cookie: string; csrf: string };
type LocalOptions = { method?: string; body?: unknown; session?: OwnerAuth; headers?: Record<string, string>; origin?: string | null };
let ctx: Awaited<ReturnType<typeof tempConfig>>;
let runStore: RunStore;
let approvals: ApprovalStore;
let oauthStore: OAuthStore;
let coordinator: RunCoordinator;
let control: ReturnType<typeof createLocalControl>;
let publicApp: ReturnType<typeof createHttpApp>;
let ownerServer: Server;
let publicServer: Server;
let publicOrigin: string;
let ownerKey: string;
let fakeCleanup: (() => Promise<void>) | undefined;

function local(path: string, options: LocalOptions = {}) {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const origin = options.origin === undefined ? method === "GET" || method === "HEAD" ? undefined : control.origin : options.origin;
  return fetch(`${control.origin}${path}`, { method, redirect: "manual", headers: {
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(origin !== undefined && origin !== null ? { origin } : {}),
    ...(options.session ? { cookie: options.session.cookie, "x-vibe-csrf": options.session.csrf } : {}),
    ...options.headers,
  }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}

function rawLocal(path: string, headers: Record<string, string>): Promise<number> {
  // Fetch implementations may ignore Host overrides; use a real HTTP request for rebinding tests.
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${control.origin}${path}`, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode!));
    });
    request.once("error", reject);
    request.end();
  });
}

function publicPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${publicOrigin}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function openSession(): Promise<OwnerAuth> {
  const ticket = new URL(control.mintBootstrap()).hash.slice(1);
  const response = await local("/api/session", { body: { ticket } });
  expect(response.status).toBe(200);
  const value = await response.json();
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { csrf: value.csrf, cookie };
}

async function authorize(state = "original-state") {
  const client = oauthStore.registerClient({ redirectUris: ["https://chatgpt.com/aip/callback"], clientName: "ChatGPT" });
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUris[0],
    code_challenge: pkceS256(verifier), code_challenge_method: "S256", scope: "mcp", resource: `${publicOrigin}/mcp`, state, approve: "1" });
  const response = await fetch(`${publicOrigin}/authorize?${params}`, { redirect: "manual" });
  expect(response.status).toBe(200);
  const html = await response.text();
  const handle = html.match(/\/authorize\/continue\?handle=([A-Za-z0-9_-]+)/)![1];
  const pending = oauthStore.listAuthorizations().find((entry) => entry.clientId === client.clientId)!;
  return { client, verifier, params, handle, pending };
}

async function state(session: OwnerAuth) {
  const response = await local("/api/state", { session });
  expect(response.status).toBe(200);
  return response.json();
}

async function startFakeCodex() {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); });
  const ws = new WebSocketServer({ server });
  const received: Array<{ id?: string | number; method?: string; result?: any; error?: any; params?: any }> = [];
  let live: WebSocket | undefined;
  const cwd = await fs.realpath(ctx.root);
  const threadId = "owner-test-thread";
  const turnId = "owner-test-turn";
  ws.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (!message.method || message.id == null) return;
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialize") return reply({ ok: true });
      if (message.method === "thread/start") return reply({ thread: { id: threadId, cwd, status: { type: "idle" }, turns: [] } });
      if (message.method === "turn/start") { live = socket; return reply({ turn: { id: turnId, status: "inProgress", items: [] } }); }
      if (message.method === "thread/read") return reply({ thread: { id: threadId, cwd, turns: [{ id: turnId, status: "inProgress", items: [] }] } });
      return socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported test method" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.config.codexAppServerMode = "manual";
  ctx.config.codexAppServerUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await gitInit(ctx.root, ctx.config);
  fakeCleanup = async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
  };
  return {
    received,
    sendRequest(id: string, method: string, params: Record<string, unknown>) {
      if (!live || live.readyState !== WebSocket.OPEN) throw new Error("No retained test Codex connection");
      live.send(JSON.stringify({ id, method, params: { threadId, turnId, itemId: "owner-item", ...params } }));
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  ctx = await tempConfig();
  ctx.config.disableAuth = false;
  ctx.config.relayToken = "public-static-test-secret";
  ctx.config.urlToken = "vibe_public_url_test_secret_that_must_not_leak";
  ctx.config.enableExperimentalOAuth = true;
  ctx.config.oauthRequireLocalApproval = false;
  ctx.config.codexAppServerMode = "disabled";
  ctx.config.codexTimeoutMs = 60_000;
  ownerKey = randomBytes(32).toString("base64url");
  fakeCleanup = undefined;
  runStore = initRunStore(ctx.config.databasePath);
  approvals = new ApprovalStore(ctx.config.databasePath);
  oauthStore = new OAuthStore(ctx.config.databasePath);
  coordinator = getRunCoordinator(ctx.config, runStore);
  // Bind first so the exact expected Host is known, without a free-port race.
  ownerServer = createServer();
  await new Promise<void>((resolve) => ownerServer.listen(0, "127.0.0.1", resolve));
  ctx.config.controlPort = (ownerServer.address() as AddressInfo).port;
  control = createLocalControl({ config: ctx.config, runStore, approvals, oauthStore, ownerKey });
  ownerServer.on("request", control.app);
  ctx.config.port = 0;
  publicApp = createHttpApp(ctx.config, () => new McpServer({ name: "owner-boundary-test", version: "1" }), undefined, oauthStore);
  publicServer = listen(ctx.config, publicApp);
  await new Promise<void>((resolve) => publicServer.once("listening", resolve));
  ctx.config.port = (publicServer.address() as AddressInfo).port;
  publicOrigin = `http://127.0.0.1:${ctx.config.port}`;
  ctx.config.publicBaseUrl = publicOrigin;
  ctx.config.oauthIssuerBaseUrl = publicOrigin;
});

afterEach(async () => {
  vi.restoreAllMocks();
  control.close();
  await coordinator.close();
  await publicApp.locals.dispose();
  await Promise.all([ownerServer, publicServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await fakeCleanup?.();
  approvals.close();
  oauthStore.close();
  if (runStore.db.open) runStore.db.close();
  await ctx.cleanup();
});

describe("separate local owner control plane", () => {
  it("has two distinct loopback listeners and no owner routes on the public app", async () => {
    expect((ownerServer.address() as AddressInfo).address).toBe("127.0.0.1");
    expect((publicServer.address() as AddressInfo).address).toBe("127.0.0.1");
    expect(control.origin).not.toBe(publicOrigin);
    const session = await openSession();
    for (const route of ["/", "/control.js", "/control.css", "/api/session", "/api/state", "/api/runs/missing/result"]) {
      expect((await fetch(`${publicOrigin}${route}`, { headers: { cookie: session.cookie, authorization: `Bearer ${ownerKey}` } })).status).toBe(404);
    }
    for (const route of ["/api/bootstrap-ticket", "/api/session", "/api/logout", "/api/projects", "/api/tasks", "/api/connections/missing", "/api/approvals/missing", "/api/requests/missing"]) {
      expect((await publicPost(route, { decision: "approve", ticket: "test" }, { cookie: session.cookie, "x-vibe-csrf": session.csrf,
        origin: control.origin, authorization: `Bearer ${ownerKey}` })).status).toBe(404);
    }
    expect((await local("/mcp", { headers: { authorization: `Bearer ${ctx.config.relayToken}` } })).status).toBe(404);
  });

  it("serves a locked shell with strict headers and no embedded credentials", async () => {
    for (const path of ["/", "/control.js", "/control.css"]) {
      const response = await local(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-powered-by")).toBeNull();
      const text = await response.text();
      for (const secret of [ownerKey, ctx.config.relayToken!, ctx.config.urlToken!]) expect(text).not.toContain(secret);
      if (path === "/control.js") {
        expect(text).toContain("history.replaceState");
        expect(text).toContain("credentials:'same-origin'");
        expect(text).not.toContain("innerHTML");
        expect(text).not.toMatch(/(?:localStorage|sessionStorage)\.setItem\(['"](?:csrf|ticket|session|owner|token)/i);
      }
    }
    expect((await local("/api/state")).status).toBe(401);
    expect(collectDiagnostics).not.toHaveBeenCalled();
  });

  it("rejects DNS-rebinding Host aliases, incorrect ports and all forwarded proxy headers", async () => {
    const session = await openSession();
    for (const host of [`localhost:${ctx.config.controlPort}`, "evil.example", "127.0.0.1", `127.0.0.1:${ctx.config.port}`]) {
      expect(await rawLocal("/api/state", { host, cookie: session.cookie })).toBe(403);
      expect(await rawLocal("/", { host })).toBe(403);
    }
    const proxyHeaders: Array<Record<string, string>> = [{ "x-forwarded-host": `127.0.0.1:${ctx.config.controlPort}` }, { "x-forwarded-for": "127.0.0.1" }, { "x-forwarded-proto": "http" }];
    for (const headers of proxyHeaders) {
      expect((await local("/api/state", { session, headers })).status).toBe(403);
      expect((await local("/api/bootstrap-ticket", { body: {}, origin: null, headers: { ...headers, authorization: `Bearer ${ownerKey}` } })).status).toBe(403);
    }
    expect(collectDiagnostics).not.toHaveBeenCalled();
  });

  it("rejects foreign/null origins and requires exact local Origin for every browser mutation", async () => {
    const session = await openSession();
    for (const origin of ["https://evil.example", publicOrigin, `http://localhost:${ctx.config.controlPort}`, "null"]) {
      expect((await local("/api/state", { session, origin })).status).toBe(403);
      expect((await local("/api/logout", { session, origin, body: {} })).status).toBe(403);
      expect((await local("/api/session", { origin, body: { ticket: new URL(control.mintBootstrap()).hash.slice(1) } })).status).toBe(403);
    }
    expect((await local("/api/logout", { session, origin: null, body: {} })).status).toBe(403);
    expect((await local("/api/projects", { session, origin: null, body: {} })).status).toBe(403);
    const ticket = new URL(control.mintBootstrap()).hash.slice(1);
    expect((await local("/api/session", { origin: null, body: { ticket } })).status).toBe(403);
    expect((await local("/api/session", { body: { ticket } })).status).toBe(200);
    expect((await local("/api/session", { session, origin: control.origin })).status).toBe(200);
  });

  it("does not accept public relay, URL or OAuth credentials as owner sessions", async () => {
    const client = oauthStore.registerClient({ redirectUris: ["https://chatgpt.com/aip/callback"] });
    const token = oauthStore.createAccessToken({ clientId: client.clientId, scope: "mcp", config: ctx.config });
    for (const credential of [ctx.config.relayToken!, ctx.config.urlToken!, token.token, ownerKey]) {
      expect((await local("/api/state", { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    }
    expect((await local(`/api/state?vibe_token=${ctx.config.urlToken}`)).status).toBe(401);
    expect((await local("/api/state", { headers: { cookie: "vibe_owner=made-up" } })).status).toBe(401);
  });
});

describe("owner bootstrap, sessions and CSRF", () => {
  it("loads one private durable owner key without publishing it", async () => {
    const first = await loadOwnerKey(ctx.config.ownerDataDir);
    const second = await loadOwnerKey(ctx.config.ownerDataDir);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect((await fs.stat(`${ctx.config.ownerDataDir}/owner.key`)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(ctx.config.ownerDataDir)).mode & 0o777).toBe(0o700);
    expect(await (await local("/")).text()).not.toContain(first);
  });

  it("lets only the owner CLI credential mint short-lived fragment links", async () => {
    for (const credential of [undefined, ctx.config.relayToken, "incorrect-owner-key"]) {
      expect((await local("/api/bootstrap-ticket", { body: {}, origin: null,
        headers: credential ? { authorization: `Bearer ${credential}` } : {} })).status).toBe(401);
    }
    expect((await local("/api/bootstrap-ticket", { body: {}, origin: "https://evil.example", headers: { authorization: `Bearer ${ownerKey}` } })).status).toBe(403);
    const response = await local("/api/bootstrap-ticket", { body: {}, origin: null, headers: { authorization: `Bearer ${ownerKey}` } });
    expect(response.status).toBe(200);
    const { url } = await response.json();
    const parsed = new URL(url);
    expect(parsed.origin).toBe(control.origin);
    expect(parsed.pathname).toBe("/");
    expect(parsed.search).toBe("");
    expect(parsed.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain(ownerKey);
  });

  it("atomically exchanges a ticket once into an HttpOnly SameSite session and distinct CSRF token", async () => {
    const ticket = new URL(control.mintBootstrap()).hash.slice(1);
    const responses = await Promise.all([local("/api/session", { body: { ticket } }), local("/api/session", { body: { ticket } })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const success = responses.find((response) => response.status === 200)!;
    const cookieHeader = success.headers.get("set-cookie")!;
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
    expect(cookieHeader).toContain("Max-Age=28800");
    expect(cookieHeader).toContain("Path=/");
    const { csrf } = await success.json();
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf).not.toBe(ticket);
    expect(cookieHeader).not.toContain(csrf);
    expect(cookieHeader).not.toContain(ticket);
    const session = { cookie: cookieHeader.split(";")[0], csrf };
    expect((await (await local("/api/session", { session })).json()).csrf).toBe(csrf);
    expect((await local("/api/session", { body: { ticket } })).status).toBe(401);
  });

  it("expires bootstrap tickets at exactly 60 seconds and never restores a spent ticket", async () => {
    const ticket = new URL(control.mintBootstrap()).hash.slice(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect((await local("/api/session", { body: { ticket } })).status).toBe(401);
    clock.mockReturnValue(now);
    expect((await local("/api/session", { body: { ticket } })).status).toBe(401);
    expect((await local("/api/session", { body: { ticket: "guessed-ticket" } })).status).toBe(401);
  });

  it("requires a session-specific CSRF token on writes, not on read-only polling", async () => {
    const first = await openSession();
    const second = await openSession();
    const approval = approvals.create({ reason: "Local approval test", actionRisk: "execute", actionSummary: { command: "git status" } });
    for (const csrf of ["", "wrong-csrf", second.csrf]) {
      expect((await local(`/api/approvals/${approval.id}`, { session: first, body: { decision: "approve" }, headers: { "x-vibe-csrf": csrf } })).status).toBe(403);
    }
    expect(approvals.list()[0].status).toBe("pending");
    expect((await local("/api/state", { session: first, headers: { "x-vibe-csrf": "" } })).status).toBe(200);
    expect((await local(`/api/approvals/${approval.id}`, { session: first, body: { decision: "approve" } })).status).toBe(200);
    expect(approvals.list()[0].status).toBe("approved");
    expect((await local(`/api/approvals/${approval.id}`, { session: first, body: { decision: "reject" } })).status).toBe(400);
  });

  it("expires owner sessions at eight hours", async () => {
    const session = await openSession();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 8 * 60 * 60_000);
    expect((await local("/api/session", { session })).status).toBe(401);
    expect((await local("/api/state", { session })).status).toBe(401);
    expect((await local("/api/logout", { session, body: {} })).status).toBe(401);
  });

  it("invalidates the session on logout, keeps other sessions, and clears everything on close", async () => {
    const first = await openSession();
    const second = await openSession();
    const response = await local("/api/logout", { session: first, body: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await local("/api/state", { session: first })).status).toBe(401);
    expect((await local("/api/session", { session: second })).status).toBe(200);
    const ticket = new URL(control.mintBootstrap()).hash.slice(1);
    control.close();
    expect((await local("/api/session", { session: second })).status).toBe(401);
    expect((await local("/api/session", { body: { ticket } })).status).toBe(401);
  });
});

describe("owner OAuth transactions and local polling", () => {
  it("allows pairing only via an authenticated local owner decision across the two listeners", async () => {
    const session = await openSession();
    const auth = await authorize("bound-state");
    const data = await state(session);
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]).toMatchObject({ id: auth.pending.id, clientId: auth.client.clientId, redirectUri: auth.client.redirectUris[0] });
    for (const key of ["handle", "state", "codeChallenge", "code", "token"]) expect(data.connections[0]).not.toHaveProperty(key);
    const path = `/api/connections/${auth.pending.id}`;
    expect((await publicPost(path, { decision: "approve" }, { cookie: session.cookie, "x-vibe-csrf": session.csrf, origin: control.origin })).status).toBe(404);
    expect((await publicPost("/authorize", { ...Object.fromEntries(auth.params), decision: "approve" })).status).toBe(403);
    expect((await local(path, { body: { decision: "approve" } })).status).toBe(401);
    expect((await local(path, { session, origin: publicOrigin, body: { decision: "approve" } })).status).toBe(403);
    expect((await local(path, { session, headers: { "x-vibe-csrf": "wrong" }, body: { decision: "approve" } })).status).toBe(403);
    expect((await local(path, { session, body: { decision: "unknown" } })).status).toBe(400);
    expect(oauthStore.completeAuthorization(auth.handle)).toEqual({ status: "pending" });
    expect((await local(path, { session, body: { decision: "approve" } })).status).toBe(200);
    expect((await local(path, { session, body: { decision: "approve" } })).status).toBe(400);
    expect((await state(session)).connections).toEqual([]);
    const continued = await fetch(`${publicOrigin}/authorize/continue?handle=${auth.handle}&state=changed&redirect_uri=https://evil.example`, { redirect: "manual" });
    expect(continued.status).toBe(302);
    const location = new URL(continued.headers.get("location")!);
    expect(location.origin).toBe("https://chatgpt.com");
    expect(location.searchParams.get("state")).toBe("bound-state");
    const tokenResponse = await publicPost("/token", { grant_type: "authorization_code", code: location.searchParams.get("code"),
      client_id: auth.client.clientId, redirect_uri: auth.client.redirectUris[0], code_verifier: auth.verifier });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json();
    expect(oauthStore.verifyAccessToken(token.access_token)?.clientId).toBe(auth.client.clientId);
    const init = await publicPost("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "owner-pairing-test", version: "1" },
    } }, { authorization: `Bearer ${token.access_token}`, accept: "application/json, text/event-stream" });
    expect(init.status).toBe(200);
    await init.text();
    expect((await fetch(`${publicOrigin}/authorize/continue?handle=${auth.handle}`, { redirect: "manual" })).status).toBe(400);
    const finalState = JSON.stringify(await state(session));
    for (const secret of [ownerKey, session.csrf, auth.handle, auth.verifier, token.access_token, token.refresh_token]) expect(finalState).not.toContain(secret);
  });

  it("lets the owner reject pairing and refuses expired decisions", async () => {
    const session = await openSession();
    const auth = await authorize();
    expect((await local(`/api/connections/${auth.pending.id}`, { session, body: { decision: "reject" } })).status).toBe(200);
    const redirect = await fetch(`${publicOrigin}/authorize/continue?handle=${auth.handle}`, { redirect: "manual" });
    expect(redirect.headers.get("location")).toContain("error=access_denied");
    expect(redirect.headers.get("location")).not.toContain("code=");
    const expires = await authorize();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    expect((await local(`/api/connections/${expires.pending.id}`, { session, body: { decision: "approve" } })).status).toBe(400);
    expect((await state(session)).connections).toEqual([]);
  });

  it("caches diagnostics, not approvals or connections, and excludes all service credentials", async () => {
    const session = await openSession();
    await Promise.all([state(session), state(session), state(session)]);
    expect(collectDiagnostics).toHaveBeenCalledTimes(1);
    const auth = await authorize();
    const approval = approvals.create({ reason: "Pending local action", actionRisk: "write", actionSummary: { path: "safe.txt" } });
    const value = await state(session);
    expect(value.connections[0].id).toBe(auth.pending.id);
    expect(value.approvals[0].id).toBe(approval.id);
    const serialized = JSON.stringify(value);
    for (const secret of [ownerKey, ctx.config.relayToken!, ctx.config.urlToken!, session.csrf, auth.handle, auth.verifier]) expect(serialized).not.toContain(secret);
    expect(collectDiagnostics).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await state(session);
    expect(collectDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("polls live Codex requests and sends one-use local replies without persisting answers", async () => {
    const fake = await startFakeCodex();
    const session = await openSession();
    const run = await coordinator.start({ workspacePath: ctx.root, prompt: "Test local input", autonomy: "workspace" });
    expect((await state(session)).requests).toEqual([]);
    fake.sendRequest("input-rpc", "item/tool/requestUserInput", { questions: [{ id: "details", header: "Details", question: "Which change?", options: null }] });
    await expect.poll(() => coordinator.pendingRequests().length).toBe(1);
    const current = await state(session);
    expect(current.requests).toHaveLength(1);
    const request = current.requests[0];
    expect(request).toMatchObject({ runId: run.id, method: "item/tool/requestUserInput" });
    expect(request.params.questions[0].id).toBe("details");
    expect(request).not.toHaveProperty("rpcId");
    expect(request).not.toHaveProperty("session");
    expect(request).not.toHaveProperty("result");
    expect(collectDiagnostics).toHaveBeenCalledTimes(1);
    const path = `/api/requests/${request.id}`;
    const answer = `test-sensitive-answer-${randomBytes(24).toString("base64url")}`;
    const result = { answers: { details: { answers: [answer] } } };
    expect((await publicPost(path, { result }, { cookie: session.cookie, "x-vibe-csrf": session.csrf })).status).toBe(404);
    expect((await local(path, { body: { result } })).status).toBe(401);
    expect((await local(path, { session, headers: { "x-vibe-csrf": "wrong" }, body: { result } })).status).toBe(403);
    expect((await local(path, { session, body: { result: { answers: {} } } })).status).toBe(400);
    expect(coordinator.pendingRequests()).toHaveLength(1);
    expect((await local(path, { session, body: { result } })).status).toBe(200);
    await expect.poll(() => fake.received.some((message) => message.id === "input-rpc" && message.result?.answers?.details?.answers?.[0] === answer)).toBe(true);
    expect((await local(path, { session, body: { result } })).status).toBe(400);
    const after = await state(session);
    expect(after.requests).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(answer);
    expect(JSON.stringify(runStore.db.prepare("SELECT * FROM runs").all())).not.toContain(answer);
    expect(JSON.stringify(runStore.db.prepare("SELECT * FROM local_approvals").all())).not.toContain(answer);
    expect(runStore.getRun(run.id)?.metadata?.pendingRequests).toEqual([]);
  });

  it("keeps declared secret-input requests out of the owner decision queue", async () => {
    const fake = await startFakeCodex();
    const session = await openSession();
    await coordinator.start({ workspacePath: ctx.root, prompt: "Test secret request rejection", autonomy: "workspace" });
    fake.sendRequest("secret-rpc", "item/tool/requestUserInput", { questions: [{ id: "password", question: "Password?", isSecret: true }] });
    await expect.poll(() => fake.received.some((message) => message.id === "secret-rpc" && message.error)).toBe(true);
    expect(coordinator.pendingRequests()).toEqual([]);
    expect((await state(session)).requests).toEqual([]);
    expect(fake.received.some((message) => message.id === "secret-rpc" && message.result)).toBe(false);
  });
});
