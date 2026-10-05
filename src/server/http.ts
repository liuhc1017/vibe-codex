import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Config } from "../config/types.js";
import { bearerAuth, getAuthMethod, getAuthPrincipal, getOAuthGrant } from "./auth.js";
import { logger } from "../util/logger.js";
import { AuthSessionStore } from "./authSessions.js";
import { canonicalOAuthResource, OAuthStore, OAuthTokenPair, validateOAuthResource, validateOAuthScope, validateRedirectUri } from "./oauthStore.js";
import { RateLimiter, sendRateLimited } from "./rateLimit.js";

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  principal: string;
}

const MCP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

function requestBaseUrl(req: express.Request, config: Config): string {
  // With no configured public issuer, discovery is deliberately local, never Host-controlled.
  return (config.oauthIssuerBaseUrl || config.publicBaseUrl || `http://127.0.0.1:${req.socket.localPort ?? config.port}`).replace(/\/+$/, "");
}

function requestOAuthConfig(req: express.Request, config: Config): Config {
  return config.oauthIssuerBaseUrl || config.publicBaseUrl ? config : { ...config, publicBaseUrl: requestBaseUrl(req, config) };
}

function requestSecrets(req: express.Request): string[] {
  const secrets: string[] = [];
  const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) secrets.push(bearer);
  if (typeof req.params.urlToken === "string") secrets.push(req.params.urlToken);
  if (typeof req.query.vibe_token === "string") secrets.push(req.query.vibe_token);
  return secrets;
}

function redactSecrets(config: Config, value: string | undefined, extraSecrets: string[] = []): string | undefined {
  if (!value) return value;
  let redacted = value;
  for (const secret of [config.urlToken, config.relayToken, ...extraSecrets]) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function developmentErrorDetails(config: Config, error: unknown, extraSecrets: string[] = []) {
  if (!config.developmentMode) return {};
  if (error instanceof Error) return { message: redactSecrets(config, error.message, extraSecrets), stack: redactSecrets(config, error.stack, extraSecrets) };
  return { message: redactSecrets(config, String(error), extraSecrets) };
}

function oauthDisabled(res: express.Response) { return res.status(404).json({ error: "experimental_oauth_disabled" }); }

function redirectWithError(redirectUri: string, error: string, state?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]!);
}

function renderWaitingPage(handle: string, details?: { clientId: string; redirectUri: string; scope: string; resource: string }) {
  const continuation = `/authorize/continue?handle=${encodeURIComponent(handle)}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3;url=${escapeHtml(continuation)}"><title>Connection approval · Vibe Codex</title>
<style>:root{color-scheme:light dark;--bg:#F5F8FC;--surface:#fff;--text:#223247;--muted:#59677b;--line:#d9e1ee;--action:#2855C7}
@media(prefers-color-scheme:dark){:root{--bg:#161e2a;--surface:#202c3c;--text:#e4eaf5;--muted:#b0bfd4;--line:#405169;--action:#96b8ff}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}
main{width:100%;max-width:560px;padding:28px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}h1{font-size:24px;line-height:1.3}p{color:var(--muted)}dl{font-size:14px}dt{font-weight:600}dd{margin:0 0 12px;overflow-wrap:anywhere}a{color:var(--action)}a:focus-visible{outline:3px solid var(--action);outline-offset:4px}</style></head>
<body><main><strong>Vibe Codex</strong><h1>Waiting for local owner approval</h1>
<p>Open the Vibe Codex control page on the Mac running the relay to approve or reject this connection. This public page cannot grant access.</p>
${details ? `<dl><dt>Client ID</dt><dd>${escapeHtml(details.clientId)}</dd><dt>Redirect URI</dt><dd>${escapeHtml(details.redirectUri)}</dd><dt>Scope</dt><dd>${escapeHtml(details.scope)}</dd><dt>Resource</dt><dd>${escapeHtml(details.resource)}</dd></dl>` : ""}
<p>The request expires after 10 minutes. This page checks for a local decision automatically.</p><a href="${escapeHtml(continuation)}">Check approval status</a></main></body></html>`;
}

function sendWaitingPage(res: express.Response, handle: string, details?: Parameters<typeof renderWaitingPage>[1]) {
  return res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
    .setHeader("Referrer-Policy", "no-referrer").setHeader("X-Content-Type-Options", "nosniff")
    .type("html").send(renderWaitingPage(handle, details));
}

function checkRateLimit(req: express.Request, res: express.Response, limiter: RateLimiter, name: string): boolean {
  const result = limiter.check(`${name}:${req.ip || req.socket.remoteAddress || "unknown"}`);
  if (result.allowed) return true;
  sendRateLimited(res, result);
  return false;
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

async function cleanupMcpSessions(sessions: Map<string, McpSession>, authSessions: AuthSessionStore, now = Date.now()) {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastSeenAt <= MCP_SESSION_TTL_MS) continue;
    sessions.delete(sessionId);
    authSessions.delete(sessionId);
    await session.server.close().catch((error) => logger.warn("stale_mcp_session_close_failed", { sessionId, error: error instanceof Error ? error.message : String(error) }));
  }
}

function sendTokenPair(res: express.Response, pair: OAuthTokenPair) {
  return res.json({ access_token: pair.accessToken.token, refresh_token: pair.refreshToken, token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((Date.parse(pair.accessToken.expiresAt) - Date.now()) / 1000)),
    scope: pair.accessToken.scope });
}

export function createHttpApp(config: Config, createServer: () => McpServer, authSessions = new AuthSessionStore(), suppliedOAuthStore?: OAuthStore) {
  const oauthStore = suppliedOAuthStore ?? new OAuthStore(config.databasePath);
  const app = express();
  const sessions = new Map<string, McpSession>();
  const mcpInitializeLimiter = new RateLimiter(60, 60_000);
  const authorizeLimiter = new RateLimiter(120, 60_000);
  const tokenLimiter = new RateLimiter(120, 60_000);
  const registerLimiter = new RateLimiter(20, 60_000);
  const cleanupInterval = setInterval(() => {
    oauthStore.cleanupExpired();
    void cleanupMcpSessions(sessions, authSessions).catch((error) => logger.warn("mcp_cleanup_failed", { error: String(error) }));
  }, 60_000);
  cleanupInterval.unref();
  let disposal: Promise<void> | undefined;
  app.locals.dispose = () => disposal ??= (async () => {
    clearInterval(cleanupInterval);
    const active = [...sessions.entries()];
    sessions.clear();
    for (const [id] of active) authSessions.delete(id);
    await Promise.all(active.map(([, session]) => session.server.close().catch(() => {})));
    if (!suppliedOAuthStore) oauthStore.close();
  })();
  app.locals.oauthStore = oauthStore;
  app.locals.mcpSessions = sessions;
  app.locals.authSessions = authSessions;
  app.locals.oauthCleanupInterval = cleanupInterval;
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(["/authorize", "/token", "/revoke", "/register"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", version: "0.3.0" }));

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    const baseUrl = requestBaseUrl(req, config);
    res.json({ resource: canonicalOAuthResource(config, baseUrl), authorization_servers: [baseUrl], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    const baseUrl = requestBaseUrl(req, config);
    res.json({ issuer: baseUrl, authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`, revocation_endpoint: `${baseUrl}/revoke`, response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["mcp"] });
  });

  app.post("/register", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, registerLimiter, "oauth_register")) return;
    const redirectUris: unknown = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 20
      || !redirectUris.every((uri) => typeof uri === "string" && validateRedirectUri(config, uri))) return res.status(400).json({ error: "invalid_redirect_uri" });
    const client = oauthStore.registerClient({ redirectUris, clientName: stringValue(req.body?.client_name)?.slice(0, 200) });
    res.status(201).json({ client_id: client.clientId, client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      redirect_uris: client.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  });

  app.get("/authorize", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, authorizeLimiter, "oauth_authorize")) return;
    const clientId = stringValue(req.query.client_id) ?? "";
    const redirectUri = stringValue(req.query.redirect_uri) ?? "";
    const codeChallenge = stringValue(req.query.code_challenge) ?? "";
    const state = stringValue(req.query.state);
    const scope = stringValue(req.query.scope) ?? "mcp";
    const resource = stringValue(req.query.resource) ?? canonicalOAuthResource(config, requestBaseUrl(req, config))!;
    if (req.query.response_type !== "code" || !oauthStore.validateClient(clientId)) return res.status(400).send("invalid_request");
    if (!validateRedirectUri(config, redirectUri) || !oauthStore.getClient(clientId)?.redirectUris.includes(redirectUri)) return res.status(400).send("invalid_redirect_uri");
    if ((req.query.state !== undefined && (state === undefined || !state.trim()))
      || (req.query.scope !== undefined && typeof req.query.scope !== "string")
      || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) || req.query.code_challenge_method !== "S256") return res.redirect(redirectWithError(redirectUri, "invalid_request", state));
    if (!validateOAuthScope(scope)) return res.redirect(redirectWithError(redirectUri, "invalid_scope", state));
    if ((req.query.resource !== undefined && typeof req.query.resource !== "string")
      || !validateOAuthResource(config, resource, requestBaseUrl(req, config))) return res.redirect(redirectWithError(redirectUri, "invalid_target", state));
    // Neither approve=1 nor oauthRequireLocalApproval=false is an authorization credential.
    const transaction = oauthStore.createAuthorization({ clientId, redirectUri, codeChallenge, state, scope, resource, config: requestOAuthConfig(req, config) });
    sendWaitingPage(res, transaction.handle, { clientId, redirectUri, scope, resource });
  });

  app.get("/authorize/continue", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, authorizeLimiter, "oauth_continue")) return;
    const handle = stringValue(req.query.handle);
    if (!handle || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return res.status(400).send("invalid_transaction");
    const result = oauthStore.completeAuthorization(handle);
    if (result.status === "invalid") return res.status(400).send("invalid_transaction");
    if (result.status === "pending") return sendWaitingPage(res, handle);
    return res.redirect(result.redirectUrl);
  });

  app.post("/authorize", (_req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    return res.status(403).json({ error: "local_owner_approval_required" });
  });

  app.post("/token", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, tokenLimiter, "oauth_token")) return;
    const clientId = stringValue(req.body?.client_id) ?? "";
    const resource = stringValue(req.body?.resource);
    if ((req.body?.resource !== undefined && resource === undefined) || !validateOAuthResource(config, resource, requestBaseUrl(req, config))) return res.status(400).json({ error: "invalid_target" });
    if (req.body?.grant_type === "refresh_token") {
      const scope = stringValue(req.body?.scope);
      if (req.body?.scope !== undefined && scope === undefined) return res.status(400).json({ error: "invalid_scope" });
      const result = oauthStore.rotateRefreshToken({ refreshToken: stringValue(req.body?.refresh_token) ?? "", clientId, scope,
        resource: resource ?? canonicalOAuthResource(config, requestBaseUrl(req, config)), config: requestOAuthConfig(req, config) });
      return result.ok ? sendTokenPair(res, result.pair) : res.status(400).json({ error: result.error });
    }
    if (req.body?.grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });
    const result = oauthStore.exchangeCode({ code: stringValue(req.body?.code) ?? "", clientId,
      redirectUri: stringValue(req.body?.redirect_uri) ?? "", codeVerifier: stringValue(req.body?.code_verifier) ?? "",
      resource: resource ?? canonicalOAuthResource(config, requestBaseUrl(req, config)), config: requestOAuthConfig(req, config) });
    return result.ok ? sendTokenPair(res, result.pair) : res.status(400).json({ error: result.error });
  });

  app.post("/revoke", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, tokenLimiter, "oauth_revoke")) return;
    const token = stringValue(req.body?.token);
    if (token) oauthStore.revokeToken(token, stringValue(req.body?.client_id));
    res.status(200).json({});
  });

  app.all(["/mcp", "/mcp/:urlToken"], bearerAuth(config, oauthStore), async (req, res) => {
    const extraSecrets = requestSecrets(req);
    try {
      await cleanupMcpSessions(sessions, authSessions);
      const sessionId = req.header("mcp-session-id");
      const principal = getAuthPrincipal(req)!;
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (session && session.principal !== principal) {
        return res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing MCP session id" }, id: null });
      }
      if (!session && !sessionId && req.method === "POST" && isInitializeBody(req.body)) {
        if (!checkRateLimit(req, res, mcpInitializeLimiter, "mcp_initialize")) return;
        const server = createServer();
        const authMethod = getAuthMethod(req) ?? "bearer";
        const oauthTokenRecord = getOAuthGrant(req);
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server, transport, lastSeenAt: Date.now(), principal });
            authSessions.create({ mcpSessionId: newSessionId, authMethod, remoteHost: req.ip,
              userAgent: req.header("user-agent"), oauthTokenExpiresAt: oauthTokenRecord?.expiresAt,
              oauthClientId: oauthTokenRecord?.clientId, config });
            logger.info("mcp_session_initialized", { sessionId: newSessionId });
          },
          onsessionclosed: async (closedSessionId) => {
            const closed = sessions.get(closedSessionId);
            sessions.delete(closedSessionId);
            authSessions.delete(closedSessionId);
            await closed?.server.close().catch((error) => logger.warn("mcp_session_server_close_failed", { sessionId: closedSessionId, error: error instanceof Error ? error.message : String(error) }));
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            sessions.delete(closedSessionId);
            authSessions.delete(closedSessionId);
          }
        };
        try { await server.connect(transport); }
        catch (error) { await server.close().catch(() => {}); throw error; }
        session = { server, transport, lastSeenAt: Date.now(), principal };
      } else if (!session) {
        return res.status(sessionId ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing MCP session id" }, id: null });
      }
      session.lastSeenAt = Date.now();
      if (sessionId) {
        const authSession = authSessions.touch(sessionId);
        if (authSession && getOAuthGrant(req)) authSession.oauthTokenExpiresAt = getOAuthGrant(req)!.expiresAt;
      }
      try { await session.transport.handleRequest(req, res, req.body); }
      finally {
        // A rejected initialize has no map entry for dispose() to find.
        if (!session.transport.sessionId) await session.server.close().catch(() => {});
      }
    } catch (error) {
      logger.error("mcp_request_failed", { error: redactSecrets(config, error instanceof Error ? error.message : String(error), extraSecrets),
        stack: config.developmentMode && error instanceof Error ? redactSecrets(config, error.stack, extraSecrets) : undefined, requestId: randomUUID() });
      if (!res.headersSent) res.status(500).json({ error: { code: "MCP_ERROR", message: "MCP request failed.", details: developmentErrorDetails(config, error, extraSecrets) } });
    }
  });
  return app;
}

export function listen(config: Config, app: express.Express) {
  const httpServer = app.listen(config.port, "127.0.0.1", () => {
    logger.info("vibe_codex_listening", { port: config.port, host: "127.0.0.1", auth: config.disableAuth ? "disabled" : config.enableExperimentalOAuth ? "oauth" : "bearer" });
    if (config.disableAuth) logger.warn("auth_disabled", { warning: "DISABLE_AUTH is enabled. Do not expose this server through a public tunnel." });
    if (config.relayToken === "dev-token") logger.warn("development_relay_token", { warning: "Bearer auth is using the default development token. Set RELAY_TOKEN before exposing the server." });
    if (config.disableAuth && config.publicBaseUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(config.publicBaseUrl)) logger.error("unsafe_public_tunnel_auth_disabled", { warning: "PUBLIC_BASE_URL appears non-local while DISABLE_AUTH=true." });
  });
  httpServer.once("close", () => { void app.locals.dispose(); });
  return httpServer;
}
