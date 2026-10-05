import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHttpApp, listen } from "../src/server/http.js";
import { tempConfig } from "./helpers.js";
import { OAuthStore, pkceS256 } from "../src/server/oauthStore.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let oauthStore: OAuthStore;
let app: ReturnType<typeof createHttpApp>;
let baseUrl: string;
let httpServer: ReturnType<typeof app.listen>;
const redirectUri = "https://chatgpt.com/aip/callback";
const verifier = () => randomBytes(32).toString("base64url");

async function registerClient(uri = redirectUri): Promise<string> {
  const response = await post("/register", { redirect_uris: [uri], client_name: "ChatGPT" });
  const body = await response.json();
  return body.client_id;
}

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
}

async function begin(args?: { clientId?: string; redirectUri?: string; verifier?: string; extra?: Record<string, string> }) {
  const uri = args?.redirectUri ?? redirectUri;
  const clientId = args?.clientId ?? await registerClient(uri);
  const codeVerifier = args?.verifier ?? verifier();
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: uri,
    code_challenge: pkceS256(codeVerifier), code_challenge_method: "S256", state: "original-state", scope: "mcp",
    resource: `${baseUrl}/mcp`, ...args?.extra });
  const response = await fetch(`${baseUrl}/authorize?${params}`, { redirect: "manual" });
  const html = await response.text();
  const handle = html.match(/\/authorize\/continue\?handle=([A-Za-z0-9_-]+)/)?.[1];
  return { clientId, verifier: codeVerifier, redirectUri: uri, response, html, handle, params };
}

async function getCode(args?: Parameters<typeof begin>[0]) {
  const auth = await begin(args);
  expect(auth.response.status).toBe(200);
  expect(auth.handle).toBeTruthy();
  const pending = oauthStore.listAuthorizations().find((item) => item.clientId === auth.clientId)!;
  expect(oauthStore.decideAuthorization(pending.id, "approve").ok).toBe(true);
  const response = await fetch(`${baseUrl}/authorize/continue?handle=${auth.handle}`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  return { ...auth, code: location.searchParams.get("code")!, location };
}

function exchange(args: { code: string; verifier: string; redirectUri?: string; clientId: string; resource?: string }) {
  return post("/token", { grant_type: "authorization_code", code: args.code, client_id: args.clientId,
    redirect_uri: args.redirectUri ?? redirectUri, code_verifier: args.verifier, resource: args.resource });
}

function refresh(refreshToken: string, clientId: string, extra?: Record<string, string>) {
  return post("/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...extra });
}

function mcp(token?: string, sessionId?: string, method = "POST", initialize = false) {
  return fetch(`${baseUrl}/mcp`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  }, ...(method === "POST" ? { body: JSON.stringify(initialize
    ? { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth-tests", version: "1" } } }
    : { jsonrpc: "2.0", id: 2, method: "ping" }) } : {}) });
}

beforeEach(async () => {
  ctx = await tempConfig();
  ctx.config.disableAuth = false;
  ctx.config.relayToken = "test-token";
  ctx.config.urlToken = "vibe_url_token_that_should_not_render";
  ctx.config.enableExperimentalOAuth = true;
  // Even this legacy flag must no longer enable unauthenticated self-approval.
  ctx.config.oauthRequireLocalApproval = false;
  oauthStore = new OAuthStore(ctx.config.databasePath);
  app = createHttpApp(ctx.config, () => new McpServer({ name: "oauth-tests", version: "1" }), undefined, oauthStore);
  httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  ctx.config.oauthIssuerBaseUrl = baseUrl;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.locals.dispose();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  oauthStore.close();
  await ctx.cleanup();
});

describe("owner-approved OAuth authorization", () => {
  it("advertises the canonical resource and refresh support", async () => {
    const resource = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json();
    const server = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(resource.resource).toBe(`${baseUrl}/mcp`);
    expect(resource.authorization_servers).toContain(baseUrl);
    expect(server.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(server.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("distinguishes the public protected resource from a separately configured OAuth issuer", async () => {
    ctx.config.publicBaseUrl = "https://resource.example";
    ctx.config.oauthIssuerBaseUrl = "https://issuer.example";
    const resource = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json();
    const server = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(resource.resource).toBe("https://resource.example/mcp");
    expect(resource.authorization_servers).toEqual(["https://issuer.example"]);
    expect(server.issuer).toBe("https://issuer.example");
    const rejected = await begin({ extra: { resource: "https://issuer.example/mcp" } });
    expect(rejected.response.headers.get("location")).toContain("error=invalid_target");
    const auth = await getCode({ extra: { resource: "https://resource.example/mcp" } });
    const token = await (await exchange(auth)).json();
    const init = await mcp(token.access_token, undefined, "POST", true);
    expect(init.status).toBe(200);
    await init.text();
  });

  it("registers nonempty exact redirect URIs, rejecting malformed DCR lists", async () => {
    const good = await post("/register", { redirect_uris: [redirectUri] });
    expect(good.status).toBe(201);
    expect((await good.json()).client_id).toMatch(/^vibe_client_/);
    for (const uris of [undefined, [], [123], [redirectUri, 123], ["https://evil.example/callback"], ["https://chatgpt.com/callback#fragment"], ["https://user:password@chatgpt.com/callback"], ["http://chatgpt.com/callback"]]) {
      expect((await post("/register", { redirect_uris: uris })).status).toBe(400);
    }
    const clientId = await registerClient();
    const exact = await begin({ clientId, redirectUri: "https://chatgpt.com/different-path" });
    expect(exact.response.status).toBe(400);
    expect(exact.response.headers.get("location")).toBeNull();
    expect(() => oauthStore.registerClient({ redirectUris: [] })).toThrow("invalid_redirect_uri");
  });

  it("removes query/config bypass and denies all public approval POSTs", async () => {
    const auth = await begin({ extra: { approve: "1" } });
    expect(auth.response.status).toBe(200);
    expect(auth.response.headers.get("location")).toBeNull();
    expect(auth.html).toContain("Waiting for local owner approval");
    expect(auth.html).not.toContain('method="POST"');
    const pending = oauthStore.listAuthorizations()[0];
    expect(auth.html).not.toContain(pending.id);
    expect(pending).not.toHaveProperty("handle");
    expect(pending).not.toHaveProperty("codeChallenge");
    expect(pending).not.toHaveProperty("state");
    for (const decision of ["approve", "reject"]) {
      const response = await post("/authorize", { ...Object.fromEntries(auth.params), handle: auth.handle, id: pending.id, decision });
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    }
    const wait = await fetch(`${baseUrl}/authorize/continue?handle=${auth.handle}&approve=1`, { redirect: "manual" });
    expect(wait.status).toBe(200);
    expect(wait.headers.get("location")).toBeNull();
    expect(oauthStore.listAuthorizations()).toHaveLength(1);
    expect((await fetch(`${baseUrl}/authorize/continue?handle=${pending.id}`, { redirect: "manual" })).status).toBe(400);
    expect((await exchange({ code: "no-code", verifier: auth.verifier, clientId: auth.clientId })).status).toBe(400);
  });

  it("has no public owner-plane endpoints or sensitive rendering", async () => {
    const auth = await begin();
    expect(auth.response.headers.get("cache-control")).toBe("no-store");
    expect(auth.response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(auth.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(auth.html).not.toContain(ctx.config.relayToken);
    expect(auth.html).not.toContain(ctx.config.urlToken);
    expect(auth.html).not.toContain(auth.verifier);
    for (const route of ["/api/state", "/api/authorizations", "/owner", "/control"]) expect((await fetch(`${baseUrl}${route}`)).status).toBe(404);
  });

  it("returns only the frozen original request after a one-use local decision", async () => {
    const auth = await begin({ redirectUri: `${redirectUri}?original=1`, extra: { state: "<script>state</script>" } });
    const pending = oauthStore.listAuthorizations()[0];
    expect(oauthStore.decideAuthorization(auth.handle!, "approve").ok).toBe(false);
    expect(oauthStore.decideAuthorization(pending.id, "approve").ok).toBe(true);
    expect(oauthStore.decideAuthorization(pending.id, "reject").ok).toBe(false);
    const response = await fetch(`${baseUrl}/authorize/continue?handle=${auth.handle}&redirect_uri=https://evil.example&state=tampered&client_id=evil&resource=evil`, { redirect: "manual" });
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://chatgpt.com");
    expect(location.searchParams.get("original")).toBe("1");
    expect(location.searchParams.get("state")).toBe("<script>state</script>");
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect((await fetch(`${baseUrl}/authorize/continue?handle=${auth.handle}`, { redirect: "manual" })).status).toBe(400);
    expect(oauthStore.listAuthorizations()).toHaveLength(0);
    expect((await exchange({ ...auth, code })).status).toBe(200);
  });

  it("delivers local rejection exactly once without issuing a code", async () => {
    const auth = await begin();
    expect(oauthStore.decideAuthorization(oauthStore.listAuthorizations()[0].id, "reject").ok).toBe(true);
    const result = oauthStore.completeAuthorization(auth.handle!);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("expected rejection");
    const url = new URL(result.redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("original-state");
    expect(url.searchParams.has("code")).toBe(false);
    expect(oauthStore.completeAuthorization(auth.handle!)).toEqual({ status: "invalid" });
  });

  it("expires pending and approved authorization transactions", async () => {
    const first = await begin();
    const second = await begin();
    const approved = oauthStore.listAuthorizations().find((item) => item.clientId === second.clientId)!;
    oauthStore.decideAuthorization(approved.id, "approve");
    const future = Date.now() + 11 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    expect(oauthStore.listAuthorizations()).toHaveLength(0);
    expect(oauthStore.completeAuthorization(first.handle!)).toEqual({ status: "invalid" });
    expect(oauthStore.completeAuthorization(second.handle!)).toEqual({ status: "invalid" });
    expect(oauthStore.decideAuthorization(approved.id, "approve").ok).toBe(false);
  });

  it("rejects unregistered clients, invalid scope/state/PKCE and invalid resources", async () => {
    expect((await begin({ clientId: "unknown-client" })).response.status).toBe(400);
    const clientId = await registerClient();
    for (const [extra, error] of [
      [{ scope: "openid" }, "invalid_scope"], [{ state: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"], [{ code_challenge: "short" }, "invalid_request"],
      [{ resource: "https://evil.example/mcp" }, "invalid_target"],
      [{ resource: `${baseUrl}/mcp?other=1` }, "invalid_target"],
      [{ resource: `${baseUrl}/mcp#fragment` }, "invalid_target"],
    ] as Array<[Record<string, string>, string]>) {
      const result = await begin({ clientId, extra });
      expect(result.response.status).toBe(302);
      expect(new URL(result.response.headers.get("location")!).searchParams.get("error")).toBe(error);
    }
    expect(oauthStore.listAuthorizations()).toHaveLength(0);
  });

  it("binds code exchange to client, exact redirect, PKCE and canonical resource", async () => {
    const auth = await getCode();
    const otherClient = await registerClient();
    for (const change of [{ verifier: verifier() }, { clientId: otherClient }, { redirectUri: "https://chatgpt.com/other" }, { resource: "https://evil.example/mcp" }]) {
      expect((await exchange({ ...auth, ...change })).status).toBe(400);
    }
    const good = await exchange(auth);
    expect(good.status).toBe(200);
    const token = await good.json();
    expect(token.access_token).toMatch(/^vibe_oauth_/);
    expect(token.refresh_token).toMatch(/^vibe_refresh_/);
    expect(good.headers.get("cache-control")).toBe("no-store");
    expect(oauthStore.verifyAccessToken(token.access_token)?.resource).toBe(`${baseUrl}/mcp`);
    expect((await exchange(auth)).status).toBe(400);
    const init = await mcp(token.access_token, undefined, "POST", true);
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    await init.text();
  });

  it("uses the local canonical resource even with no configured issuer and an untrusted Host", async () => {
    ctx.config.oauthIssuerBaseUrl = undefined;
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, { headers: { host: "evil.example" } });
    expect((await metadata.json()).resource).toBe(`${baseUrl}/mcp`);
    const auth = await getCode();
    const token = await (await exchange(auth)).json();
    const request = await mcp(token.access_token, undefined, "POST", true);
    expect(request.status).toBe(200);
    await request.text();
    const invalid = await begin({ extra: { resource: "http://evil.example/mcp" } });
    expect(invalid.response.headers.get("location")).toContain("error=invalid_target");
  });

  it("rejects old-resource exchanges and refreshes if the canonical service changes", async () => {
    const auth = await getCode();
    ctx.config.oauthIssuerBaseUrl = "https://changed.example";
    const changed = await exchange(auth);
    expect(changed.status).toBe(400);
    expect((await changed.json()).error).toBe("invalid_target");
    ctx.config.oauthIssuerBaseUrl = baseUrl;
    const token = await (await exchange(auth)).json();
    ctx.config.oauthIssuerBaseUrl = "https://changed.example";
    expect((await refresh(token.refresh_token, auth.clientId)).status).toBe(400);
    ctx.config.oauthIssuerBaseUrl = baseUrl;
    expect((await refresh(token.refresh_token, auth.clientId)).status).toBe(200);
  });

  it("exchanges a code atomically under competing HTTP requests", async () => {
    const auth = await getCode();
    const responses = await Promise.all([exchange(auth), exchange(auth)]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 400]);
  });

  it("rejects expired code and token", async () => {
    ctx.config.oauthAuthCodeTtlSeconds = -1;
    const expired = await getCode();
    expect((await exchange(expired)).status).toBe(400);
    ctx.config.oauthAuthCodeTtlSeconds = 300;
    ctx.config.oauthAccessTokenTtlSeconds = -1;
    const auth = await getCode();
    const token = await (await exchange(auth)).json();
    expect((await mcp(token.access_token, undefined, "POST", true)).status).toBe(401);
  });
});

describe("durable hashed credentials and refresh grants", () => {
  it("persists transactions, approved codes and tokens across actual store restarts with no plaintext credentials", async () => {
    const auth = await begin();
    const pendingId = oauthStore.listAuthorizations()[0].id;
    oauthStore.close();
    oauthStore = new OAuthStore(ctx.config.databasePath);
    expect(oauthStore.getClient(auth.clientId)?.redirectUris).toEqual([redirectUri]);
    expect(oauthStore.listAuthorizations()[0].id).toBe(pendingId);
    expect(oauthStore.decideAuthorization(pendingId, "approve").ok).toBe(true);
    oauthStore.close();
    oauthStore = new OAuthStore(ctx.config.databasePath);
    const completed = oauthStore.completeAuthorization(auth.handle!);
    if (completed.status !== "approved") throw new Error("expected approval");
    const code = new URL(completed.redirectUrl).searchParams.get("code")!;
    oauthStore.close();
    oauthStore = new OAuthStore(ctx.config.databasePath);
    const exchanged = oauthStore.exchangeCode({ code, clientId: auth.clientId, redirectUri, codeVerifier: auth.verifier, config: ctx.config });
    if (!exchanged.ok) throw new Error("expected exchange");
    const pair = exchanged.pair;
    oauthStore.close();
    oauthStore = new OAuthStore(ctx.config.databasePath);
    expect(oauthStore.verifyAccessToken(pair.accessToken.token)?.grantId).toBe(pair.grantId);
    expect(oauthStore.consumeCode({ code, clientId: auth.clientId, redirectUri, codeVerifier: auth.verifier }).ok).toBe(false);
    const rotated = oauthStore.rotateRefreshToken({ refreshToken: pair.refreshToken, clientId: auth.clientId, config: ctx.config });
    expect(rotated.ok).toBe(true);
    const db = new Database(ctx.config.databasePath, { readonly: true });
    try {
      const tables = ["oauth_authorizations", "oauth_codes", "oauth_grants", "oauth_access_tokens", "oauth_refresh_tokens"];
      const stored = JSON.stringify(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
      for (const secret of [auth.handle!, code, pair.accessToken.token, pair.refreshToken]) expect(stored).not.toContain(secret);
      if (rotated.ok) {
        expect(stored).not.toContain(rotated.pair.accessToken.token);
        expect(stored).not.toContain(rotated.pair.refreshToken);
      }
    } finally { db.close(); }
  });

  it("arbitrates decisions, completion, code use and refresh replay across concurrent store connections", async () => {
    const clientId = await registerClient();
    const codeVerifier = verifier();
    const transaction = oauthStore.createAuthorization({ clientId, redirectUri, codeChallenge: pkceS256(codeVerifier),
      state: "db-state", scope: "mcp", config: ctx.config });
    const second = new OAuthStore(ctx.config.databasePath);
    try {
      const id = second.listAuthorizations()[0].id;
      expect(second.decideAuthorization(id, "approve").ok).toBe(true);
      expect(oauthStore.decideAuthorization(id, "reject").ok).toBe(false);
      const completed = oauthStore.completeAuthorization(transaction.handle);
      if (completed.status !== "approved") throw new Error("expected approval");
      expect(second.completeAuthorization(transaction.handle)).toEqual({ status: "invalid" });
      const code = new URL(completed.redirectUrl).searchParams.get("code")!;
      const args = { code, clientId, redirectUri, codeVerifier, config: ctx.config };
      const exchanged = second.exchangeCode(args);
      if (!exchanged.ok) throw new Error("expected exchange");
      expect(oauthStore.exchangeCode(args).ok).toBe(false);
      const rotated = oauthStore.rotateRefreshToken({ refreshToken: exchanged.pair.refreshToken, clientId, config: ctx.config });
      if (!rotated.ok) throw new Error("expected rotation");
      expect(second.verifyAccessToken(rotated.pair.accessToken.token)?.grantId).toBe(exchanged.pair.grantId);
      expect(second.rotateRefreshToken({ refreshToken: exchanged.pair.refreshToken, clientId, config: ctx.config }).ok).toBe(false);
      expect(oauthStore.verifyAccessToken(rotated.pair.accessToken.token)).toBeNull();
    } finally { second.close(); }
  });

  it("rotates refresh credentials, preserves grant identity, and revokes the entire family on replay", async () => {
    const auth = await getCode();
    const token = await (await exchange(auth)).json();
    const original = oauthStore.verifyAccessToken(token.access_token)!;
    const wrongClient = await registerClient();
    expect((await refresh(token.refresh_token, wrongClient)).status).toBe(400);
    expect((await refresh(token.refresh_token, auth.clientId, { resource: "https://evil.example/mcp" })).status).toBe(400);
    expect((await refresh(token.refresh_token, auth.clientId, { scope: "openid" })).status).toBe(400);
    const response = await refresh(token.refresh_token, auth.clientId, { resource: `${baseUrl}/mcp`, scope: "mcp" });
    expect(response.status).toBe(200);
    const rotated = await response.json();
    expect(rotated.refresh_token).not.toBe(token.refresh_token);
    expect(oauthStore.verifyAccessToken(rotated.access_token)?.grantId).toBe(original.grantId);
    expect((await refresh(token.refresh_token, auth.clientId)).status).toBe(400);
    expect(oauthStore.verifyAccessToken(token.access_token)).toBeNull();
    expect(oauthStore.verifyAccessToken(rotated.access_token)).toBeNull();
    expect((await refresh(rotated.refresh_token, auth.clientId)).status).toBe(400);
  });

  it("keeps refresh replay detection after cleanup and restart", async () => {
    const client = oauthStore.registerClient({ redirectUris: [redirectUri] });
    const pair = oauthStore.createTokenPair({ clientId: client.clientId, scope: "mcp", config: ctx.config });
    const firstRotation = oauthStore.rotateRefreshToken({ refreshToken: pair.refreshToken, clientId: client.clientId, config: ctx.config });
    if (!firstRotation.ok) throw new Error("expected rotation");
    oauthStore.cleanupExpired(Date.now() + 2 * 60 * 60 * 1000);
    oauthStore.close();
    oauthStore = new OAuthStore(ctx.config.databasePath);
    expect(oauthStore.rotateRefreshToken({ refreshToken: pair.refreshToken, clientId: client.clientId, config: ctx.config }).ok).toBe(false);
    expect(oauthStore.rotateRefreshToken({ refreshToken: firstRotation.pair.refreshToken, clientId: client.clientId, config: ctx.config }).ok).toBe(false);
  });

  it("revokes access and refresh tokens as grants and honors optional client binding", async () => {
    for (const kind of ["access_token", "refresh_token"]) {
      const auth = await getCode();
      const token = await (await exchange(auth)).json();
      expect((await post("/revoke", { token: token[kind], client_id: "different-client" })).status).toBe(200);
      expect(oauthStore.verifyAccessToken(token.access_token)).not.toBeNull();
      expect((await post("/revoke", { token: token[kind], client_id: auth.clientId })).status).toBe(200);
      expect(oauthStore.verifyAccessToken(token.access_token)).toBeNull();
      expect((await refresh(token.refresh_token, auth.clientId)).status).toBe(400);
    }
    expect((await post("/revoke", { token: "unknown" })).status).toBe(200);
  });

  it("allows refresh after access expiry but not after the fixed refresh lifetime", async () => {
    const client = oauthStore.registerClient({ redirectUris: [redirectUri] });
    const pair = oauthStore.createTokenPair({ clientId: client.clientId, scope: "mcp", config: ctx.config });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 60 * 1000);
    expect(oauthStore.verifyAccessToken(pair.accessToken.token)).toBeNull();
    const result = oauthStore.rotateRefreshToken({ refreshToken: pair.refreshToken, clientId: client.clientId, config: ctx.config });
    expect(result.ok).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 24 * 60 * 60 * 1000);
    if (result.ok) expect(oauthStore.rotateRefreshToken({ refreshToken: result.pair.refreshToken, clientId: client.clientId, config: ctx.config }).ok).toBe(false);
  });

  it("keeps createAccessToken/verifyAccessToken compatibility and enforces store-level resource binding", async () => {
    const client = oauthStore.registerClient({ redirectUris: [redirectUri] });
    const token = oauthStore.createAccessToken({ clientId: client.clientId, scope: "mcp", config: ctx.config });
    expect(token.token).toMatch(/^vibe_oauth_/);
    expect(token.grantId).toBeTruthy();
    expect(oauthStore.verifyAccessToken(token.token)).toEqual(token);
    expect(() => oauthStore.createTokenPair({ clientId: client.clientId, scope: "mcp", resource: "https://evil.example/mcp", config: ctx.config })).toThrow("invalid_target");
    expect(oauthStore.revokeAccessToken(token.token)).toBe(true);
    expect(oauthStore.verifyAccessToken(token.token)).toBeNull();
  });
});

describe("authenticated MCP sessions", () => {
  it("sends correct Bearer challenges with 401 and never echoes invalid credentials", async () => {
    for (const token of [undefined, "vibe_oauth_invalid", "wrong-static-token"]) {
      const response = await mcp(token, undefined, "POST", true);
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate")!;
      expect(challenge).toContain("Bearer ");
      expect(challenge).toContain(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      if (token) expect(challenge).toContain('error="invalid_token"');
      else expect(challenge).not.toContain("error=");
      const text = await response.text();
      if (token) expect(text).not.toContain(token);
    }
    ctx.config.relayToken = undefined;
    expect((await mcp("undefined", undefined, "POST", true)).status).toBe(401);
  });

  it("returns unknown-session 404 (including initialize) and missing-session 400", async () => {
    expect((await mcp(ctx.config.relayToken, "unknown-session")).status).toBe(404);
    expect((await mcp(ctx.config.relayToken, "unknown-session", "POST", true)).status).toBe(404);
    expect((await mcp(ctx.config.relayToken)).status).toBe(400);
  });

  it("binds each session to its approved grant on POST, GET and DELETE, while permitting refresh", async () => {
    const auth = await getCode();
    const token = await (await exchange(auth)).json();
    const init = await mcp(token.access_token, undefined, "POST", true);
    expect(init.status).toBe(200);
    await init.text();
    const sessionId = init.headers.get("mcp-session-id")!;
    const otherAuth = await getCode();
    const other = await (await exchange(otherAuth)).json();
    // A separately approved grant for the same client is also a different principal.
    const sameClientAuth = await getCode({ clientId: auth.clientId });
    const sameClient = await (await exchange(sameClientAuth)).json();
    for (const wrongToken of [other.access_token, sameClient.access_token, ctx.config.relayToken]) {
      for (const method of ["POST", "GET", "DELETE"]) expect((await mcp(wrongToken, sessionId, method)).status).toBe(404);
    }
    const rotated = await (await refresh(token.refresh_token, auth.clientId)).json();
    const ping = await mcp(rotated.access_token, sessionId);
    expect(ping.status).toBe(200);
    await ping.text();
    expect(app.locals.authSessions.get(sessionId)?.oauthClientId).toBe(auth.clientId);
    await post("/revoke", { token: rotated.refresh_token });
    expect((await mcp(rotated.access_token, sessionId)).status).toBe(401);
  });

  it("validates token resource against the canonical service rather than supplied Host", async () => {
    const auth = await getCode();
    const token = await (await exchange(auth)).json();
    const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}`, host: "evil.example",
      "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resource-test", version: "1" } } }) });
    expect(response.status).toBe(200);
    await response.text();
    ctx.config.oauthIssuerBaseUrl = "https://changed.example";
    expect((await mcp(token.access_token, undefined, "POST", true)).status).toBe(401);
  });

  it("exposes idempotent cleanup and preserves externally owned stores", async () => {
    const init = await mcp(ctx.config.relayToken, undefined, "POST", true);
    await init.text();
    expect(app.locals.oauthStore).toBe(oauthStore);
    expect(app.locals.mcpSessions.size).toBe(1);
    await app.locals.dispose();
    await app.locals.dispose();
    expect(app.locals.mcpSessions.size).toBe(0);
    expect(app.locals.authSessions.list()).toHaveLength(0);
    expect(oauthStore.listAuthorizations()).toEqual([]);
    // An internally created store is closed by the owning app instead.
    const ownedApp = createHttpApp(ctx.config, () => new McpServer({ name: "owned", version: "1" }));
    await ownedApp.locals.dispose();
    expect(() => ownedApp.locals.oauthStore.listAuthorizations()).toThrow();
  });

  it("listens only on loopback through the production listener", async () => {
    const otherApp = createHttpApp({ ...ctx.config, port: 0 }, () => new McpServer({ name: "loopback", version: "1" }));
    const server = listen({ ...ctx.config, port: 0 }, otherApp);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await otherApp.locals.dispose();
    }
  });

  it("rate limits dynamic client registration", async () => {
    let response: Response | undefined;
    for (let i = 0; i < 21; i += 1) response = await post("/register", { redirect_uris: [redirectUri], client_name: `Client ${i}` });
    expect(response?.status).toBe(429);
  });
});
