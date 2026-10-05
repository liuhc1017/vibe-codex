import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Config } from "../config/types.js";
import { constantTimeEqual } from "../util/crypto.js";

export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: string;
}

export interface OAuthAuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

export interface OAuthAccessTokenRecord {
  token: string;
  grantId: string;
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: string;
  createdAt: string;
}

export interface OAuthTokenPair {
  accessToken: OAuthAccessTokenRecord;
  refreshToken: string;
  refreshExpiresAt: string;
  grantId: string;
}

export interface OAuthAuthorizationSummary {
  id: string;
  clientId: string;
  clientName?: string;
  redirectUri: string;
  scope: string;
  resource?: string;
  createdAt: string;
  expiresAt: string;
}

export type AuthorizationCompletion =
  | { status: "pending" }
  | { status: "approved" | "rejected"; redirectUrl: string }
  | { status: "invalid" };

type AuthorizationArgs = {
  clientId: string; redirectUri: string; codeChallenge: string; state?: string;
  scope: string; resource?: string; config: Config;
};
type TokenArgs = { clientId: string; scope: string; resource?: string; config: Config };
type CodeArgs = { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource?: string };
type Result<T> = { ok: true } & T | { ok: false; error: string };
type CodeRow = {
  code_hash: string; client_id: string; redirect_uri: string; code_challenge: string;
  scope: string; resource: string | null; created_at: string; expires_at: string; used_at: string | null;
};
type GrantRow = {
  grant_id: string; client_id: string; scope: string; resource: string | null;
  created_at: string; expires_at: string; revoked_at: string | null;
};
type AuthorizationRow = {
  id: string; client_id: string; redirect_uri: string; code_challenge: string;
  state: string | null; scope: string; resource: string | null; status: "pending" | "approved" | "rejected";
  created_at: string; expires_at: string; code_ttl_seconds: number; consumed_at: string | null;
};

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** All credentials are opaque random values. Only SHA-256 digests ever reach SQLite. */
export class OAuthStore {
  private db: Database.Database;

  constructor(databasePath?: string) {
    this.db = new Database(databasePath ?? ":memory:");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    if (databasePath && databasePath !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY, redirect_uris_json TEXT NOT NULL, client_name TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_authorizations (
        id TEXT PRIMARY KEY, handle_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, state TEXT, scope TEXT NOT NULL, resource TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, code_ttl_seconds REAL NOT NULL, consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_grants (
        grant_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS oauth_authorizations_expiry ON oauth_authorizations(expires_at);
      CREATE INDEX IF NOT EXISTS oauth_access_tokens_grant ON oauth_access_tokens(grant_id);
      CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_grant ON oauth_refresh_tokens(grant_id);
    `);
  }

  close() { if (this.db.open) this.db.close(); }
  dispose() { this.close(); }

  registerClient(args: { clientId?: string; redirectUris?: string[]; clientName?: string }): OAuthClientRecord {
    if (!args.redirectUris?.length || args.redirectUris.some((uri) => !isHttpUrl(uri))) throw new Error("invalid_redirect_uri");
    const record: OAuthClientRecord = {
      clientId: args.clientId || `vibe_client_${randomUUID()}`,
      redirectUris: [...args.redirectUris], clientName: args.clientName, createdAt: iso(),
    };
    // Registration cannot silently change an existing client's exact redirect bindings.
    this.db.prepare(`INSERT INTO oauth_clients (client_id, redirect_uris_json, client_name, created_at)
      VALUES (?, ?, ?, ?)`).run(record.clientId, JSON.stringify(record.redirectUris), record.clientName ?? null, record.createdAt);
    return record;
  }

  validateClient(clientId: string): boolean { return !!this.getClient(clientId); }

  getClient(clientId: string): OAuthClientRecord | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
      { client_id: string; redirect_uris_json: string; client_name: string | null; created_at: string } | undefined;
    if (!row) return undefined;
    try {
      const redirectUris: unknown = JSON.parse(row.redirect_uris_json);
      if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every((uri) => typeof uri === "string" && isHttpUrl(uri))) return undefined;
      return { clientId: row.client_id, redirectUris, clientName: row.client_name ?? undefined, createdAt: row.created_at };
    } catch { return undefined; }
  }

  createAuthorization(args: AuthorizationArgs): { handle: string; expiresAt: string } {
    this.validateAuthorization(args);
    this.cleanupExpired();
    const handle = randomBytes(32).toString("base64url");
    const createdAt = iso();
    const expiresAt = iso(Date.now() + AUTHORIZATION_TTL_MS);
    this.db.prepare(`INSERT INTO oauth_authorizations
      (id, handle_hash, client_id, redirect_uri, code_challenge, state, scope, resource, status, created_at, expires_at, code_ttl_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(randomUUID(), hash(handle), args.clientId, args.redirectUri, args.codeChallenge, args.state ?? null,
        args.scope, args.resource ?? canonicalOAuthResource(args.config) ?? null, createdAt, expiresAt, args.config.oauthAuthCodeTtlSeconds);
    return { handle, expiresAt };
  }

  listAuthorizations(): OAuthAuthorizationSummary[] {
    const rows = this.db.prepare(`SELECT a.*, c.client_name FROM oauth_authorizations a
      LEFT JOIN oauth_clients c ON c.client_id = a.client_id
      WHERE a.status = 'pending' AND a.consumed_at IS NULL AND a.expires_at > ? ORDER BY a.created_at`).all(iso()) as
      Array<AuthorizationRow & { client_name: string | null }>;
    return rows.map((row) => ({ id: row.id, clientId: row.client_id, clientName: row.client_name ?? undefined,
      redirectUri: row.redirect_uri, scope: row.scope, resource: row.resource ?? undefined,
      createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  /** This is intentionally only callable by the separate authenticated owner app, never a public route. */
  decideAuthorization(id: string, decision: "approve" | "reject"): Result<{ status: "approved" | "rejected" }> {
    if (decision !== "approve" && decision !== "reject") return { ok: false, error: "invalid_transaction" };
    const status = decision === "approve" ? "approved" : "rejected";
    const result = this.db.prepare(`UPDATE oauth_authorizations SET status = ?
      WHERE id = ? AND status = 'pending' AND consumed_at IS NULL AND expires_at > ?`).run(status, id, iso());
    return result.changes === 1 ? { ok: true, status } : { ok: false, error: "invalid_transaction" };
  }

  completeAuthorization(handle: string): AuthorizationCompletion {
    return this.db.transaction((): AuthorizationCompletion => {
      const row = this.db.prepare("SELECT * FROM oauth_authorizations WHERE handle_hash = ?").get(hash(handle)) as AuthorizationRow | undefined;
      if (!row || row.consumed_at || row.expires_at <= iso()) return { status: "invalid" };
      if (row.status === "pending") return { status: "pending" };
      this.db.prepare("UPDATE oauth_authorizations SET consumed_at = ? WHERE id = ?").run(iso(), row.id);
      const redirect = new URL(row.redirect_uri);
      if (row.state !== null) redirect.searchParams.set("state", row.state);
      if (row.status === "rejected") redirect.searchParams.set("error", "access_denied");
      else {
        const code = this.insertCode({ clientId: row.client_id, redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge, scope: row.scope, resource: row.resource ?? undefined }, row.code_ttl_seconds);
        redirect.searchParams.set("code", code.code);
      }
      return { status: row.status, redirectUrl: redirect.toString() };
    }).immediate();
  }

  private validateAuthorization(args: AuthorizationArgs) {
    if (!this.getClient(args.clientId)?.redirectUris.includes(args.redirectUri) || !validateRedirectUri(args.config, args.redirectUri)) throw new Error("invalid_redirect_uri");
    if (!validateOAuthScope(args.scope)) throw new Error("invalid_scope");
    if (!/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge) || (args.state !== undefined && !args.state.trim())) throw new Error("invalid_request");
    if (!validateOAuthResource(args.config, args.resource)) throw new Error("invalid_target");
  }

  createCode(args: { clientId: string; redirectUri: string; codeChallenge: string; scope?: string; resource?: string; config: Config }): OAuthAuthCodeRecord {
    this.validateAuthorization({ ...args, scope: args.scope ?? "mcp" });
    return this.insertCode({ ...args, scope: args.scope ?? "mcp", resource: args.resource ?? canonicalOAuthResource(args.config) }, args.config.oauthAuthCodeTtlSeconds);
  }

  private insertCode(args: { clientId: string; redirectUri: string; codeChallenge: string; scope: string; resource?: string }, ttlSeconds: number): OAuthAuthCodeRecord {
    const record: OAuthAuthCodeRecord = { ...args, code: randomBytes(32).toString("base64url"), createdAt: iso(), expiresAt: iso(Date.now() + ttlSeconds * 1000) };
    this.db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(hash(record.code), record.clientId, record.redirectUri,
        record.codeChallenge, record.scope, record.resource ?? null, record.createdAt, record.expiresAt);
    return record;
  }

  consumeCode(args: CodeArgs): Result<{ code: OAuthAuthCodeRecord }> {
    return this.db.transaction(() => this.consumeCodeInsideTransaction(args)).immediate();
  }

  private consumeCodeInsideTransaction(args: CodeArgs & { config?: Config }): Result<{ code: OAuthAuthCodeRecord }> {
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hash(args.code)) as CodeRow | undefined;
    if (!row || row.used_at || row.expires_at <= iso() || row.client_id !== args.clientId || row.redirect_uri !== args.redirectUri
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(args.codeVerifier) || !constantTimeEqual(pkceS256(args.codeVerifier), row.code_challenge)) return { ok: false, error: "invalid_grant" };
    if ((args.resource !== undefined && args.resource !== row.resource)
      || (args.config && !validateOAuthResource(args.config, row.resource ?? undefined))) return { ok: false, error: "invalid_target" };
    const usedAt = iso();
    this.db.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?").run(usedAt, row.code_hash);
    return { ok: true, code: { code: args.code, clientId: row.client_id, redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge, scope: row.scope, resource: row.resource ?? undefined,
      createdAt: row.created_at, expiresAt: row.expires_at, usedAt } };
  }

  /** Code consumption and token issuance are one commit (including across store instances). */
  exchangeCode(args: CodeArgs & { config: Config }): Result<{ pair: OAuthTokenPair }> {
    return this.db.transaction((): Result<{ pair: OAuthTokenPair }> => {
      const consumed = this.consumeCodeInsideTransaction(args);
      if (!consumed.ok) return consumed;
      const pair = this.createTokenPair({ clientId: consumed.code.clientId, scope: consumed.code.scope,
        resource: consumed.code.resource, config: args.config });
      return { ok: true, pair };
    }).immediate();
  }

  private createGrant(args: TokenArgs): GrantRow {
    if (!this.validateClient(args.clientId) || !validateOAuthScope(args.scope)) throw new Error("invalid_request");
    if (!validateOAuthResource(args.config, args.resource)) throw new Error("invalid_target");
    const grant: GrantRow = { grant_id: randomUUID(), client_id: args.clientId, scope: args.scope,
      resource: args.resource ?? canonicalOAuthResource(args.config) ?? null, created_at: iso(),
      expires_at: iso(Date.now() + REFRESH_TTL_MS), revoked_at: null };
    this.db.prepare(`INSERT INTO oauth_grants (grant_id, client_id, scope, resource, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(grant.grant_id, grant.client_id, grant.scope, grant.resource, grant.created_at, grant.expires_at);
    return grant;
  }

  createAccessToken(args: TokenArgs): OAuthAccessTokenRecord {
    return this.db.transaction(() => this.insertAccessToken(this.createGrant(args), args.config)).immediate();
  }

  createTokenPair(args: TokenArgs): OAuthTokenPair {
    return this.db.transaction(() => this.insertTokenPair(this.createGrant(args), args.config)).immediate();
  }

  private insertAccessToken(grant: GrantRow, config: Config): OAuthAccessTokenRecord {
    const record: OAuthAccessTokenRecord = { token: `vibe_oauth_${randomBytes(32).toString("base64url")}`,
      grantId: grant.grant_id, clientId: grant.client_id, scope: grant.scope, resource: grant.resource ?? undefined,
      createdAt: iso(), expiresAt: iso(Math.min(Date.now() + config.oauthAccessTokenTtlSeconds * 1000, Date.parse(grant.expires_at))) };
    this.db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(hash(record.token), record.grantId, record.createdAt, record.expiresAt);
    return record;
  }

  private insertTokenPair(grant: GrantRow, config: Config): OAuthTokenPair {
    const accessToken = this.insertAccessToken(grant, config);
    const refreshToken = `vibe_refresh_${randomBytes(32).toString("base64url")}`;
    this.db.prepare("INSERT INTO oauth_refresh_tokens (token_hash, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(hash(refreshToken), grant.grant_id, iso(), grant.expires_at);
    return { accessToken, refreshToken, refreshExpiresAt: grant.expires_at, grantId: grant.grant_id };
  }

  rotateRefreshToken(args: { refreshToken: string; clientId: string; scope?: string; resource?: string; config: Config }): Result<{ pair: OAuthTokenPair }> {
    return this.db.transaction((): Result<{ pair: OAuthTokenPair }> => {
      const row = this.db.prepare(`SELECT r.used_at, r.expires_at AS token_expires_at, g.* FROM oauth_refresh_tokens r
        JOIN oauth_grants g ON g.grant_id = r.grant_id WHERE r.token_hash = ?`).get(hash(args.refreshToken)) as
        GrantRow & { used_at: string | null; token_expires_at: string } | undefined;
      if (!row || row.client_id !== args.clientId || row.revoked_at || row.expires_at <= iso() || row.token_expires_at <= iso()) return { ok: false, error: "invalid_grant" };
      if (row.used_at) {
        // Keep spent refresh hashes until grant expiry: replay invalidates EVERY descendant credential.
        this.db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE grant_id = ?").run(iso(), row.grant_id);
        return { ok: false, error: "invalid_grant" };
      }
      if ((args.resource !== undefined && args.resource !== row.resource)
        || !validateOAuthResource(args.config, row.resource ?? undefined)) return { ok: false, error: "invalid_target" };
      if (args.scope !== undefined && (!validateOAuthScope(args.scope) || args.scope !== row.scope)) return { ok: false, error: "invalid_scope" };
      this.db.prepare("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?").run(iso(), hash(args.refreshToken));
      return { ok: true, pair: this.insertTokenPair(row, args.config) };
    }).immediate();
  }

  verifyAccessToken(token: string): OAuthAccessTokenRecord | null {
    const row = this.db.prepare(`SELECT a.created_at AS token_created_at, a.expires_at AS token_expires_at, g.*
      FROM oauth_access_tokens a JOIN oauth_grants g ON a.grant_id = g.grant_id
      WHERE a.token_hash = ? AND a.expires_at > ? AND g.expires_at > ? AND g.revoked_at IS NULL`)
      .get(hash(token), iso(), iso()) as GrantRow & { token_created_at: string; token_expires_at: string } | undefined;
    return row ? { token, grantId: row.grant_id, clientId: row.client_id, scope: row.scope, resource: row.resource ?? undefined,
      createdAt: row.token_created_at, expiresAt: row.token_expires_at } : null;
  }

  revokeToken(token: string, clientId?: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT g.grant_id, g.client_id FROM oauth_grants g JOIN (
        SELECT grant_id FROM oauth_access_tokens WHERE token_hash = ? UNION SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ?
      ) t ON t.grant_id = g.grant_id`).get(hash(token), hash(token)) as { grant_id: string; client_id: string } | undefined;
      if (!row || (clientId !== undefined && clientId !== row.client_id)) return false;
      this.db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE grant_id = ?").run(iso(), row.grant_id);
      return true;
    }).immediate();
  }

  revokeAccessToken(token: string): boolean { return this.revokeToken(token); }

  cleanupExpired(now = Date.now()) {
    if (!this.db.open) return;
    this.db.transaction(() => {
      const before = iso(now);
      this.db.prepare("DELETE FROM oauth_authorizations WHERE expires_at <= ?").run(before);
      this.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(before);
      this.db.prepare("DELETE FROM oauth_access_tokens WHERE expires_at <= ?").run(before);
      this.db.prepare("DELETE FROM oauth_grants WHERE expires_at <= ?").run(before);
    }).immediate();
  }
}

export function pkceS256(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export function validateRedirectUri(config: Config, redirectUri: string): boolean {
  if (!isHttpUrl(redirectUri)) return false;
  const parsed = new URL(redirectUri);
  return config.oauthAllowedRedirectHosts.includes(parsed.hostname)
    && (parsed.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
}

export function validateOAuthScope(scope: string | undefined): boolean {
  const values = (scope ?? "mcp").split(/\s+/).filter(Boolean);
  return values.length > 0 && values.every((value) => value === "mcp");
}

export function canonicalOAuthResource(config: Config, fallbackBaseUrl?: string): string {
  const base = config.publicBaseUrl || config.oauthIssuerBaseUrl || fallbackBaseUrl || `http://127.0.0.1:${config.port}`;
  return `${base.replace(/\/+$/, "")}/mcp`;
}

export function validateOAuthResource(config: Config, resource?: string, fallbackBaseUrl?: string): boolean {
  return resource === undefined || (isHttpUrl(resource) && resource === canonicalOAuthResource(config, fallbackBaseUrl));
}
