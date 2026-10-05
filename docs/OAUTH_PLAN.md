# OAuth Security Model

OAuth is recommended for ChatGPT connections in 0.3. The environment variable remains `ENABLE_EXPERIMENTAL_OAUTH=true` for compatibility. Static bearer and development URL-token authentication remain supported separately.

## Two authorization boundaries

The public bridge exposes MCP, discovery, registration, authorization waiting/continuation, token exchange and revocation. A separate loopback-only listener exposes owner decisions. The tunnel reaches only the bridge.

Neither a loopback source address (tunnels also connect from loopback), an MCP bearer credential, nor an OAuth client is an owner credential. The owner opens a private key-backed one-use ticket, exchanges it for an HttpOnly/SameSite session, and makes Host/Origin/CSRF-checked decisions. Remote `approve_action`, `approve=1`, public POST consent, and `OAUTH_REQUIRE_LOCAL_APPROVAL=false` cannot grant access.

## Implemented flow

1. Public dynamic client registration validates nonempty exact redirect URIs against the configured host policy. Client display names are self-reported, not identity evidence.
2. GET `/authorize` validates response type, registered client/redirect, PKCE S256, optional nonempty state, supported `mcp` scope and canonical resource.
3. A ten-minute durable transaction freezes those fields. The public page holds a separate high-entropy continuation handle; safe owner summaries contain neither handle, PKCE, state nor authorization code.
4. The private owner approves or rejects the transaction.
5. `/authorize/continue` returns a single redirect to the frozen registered URI with the original state. A public page cannot choose a different redirect or approve itself.
6. `/token` atomically consumes the hashed code after exact client/redirect/PKCE/resource validation and issues access/refresh credentials.

SQLite stores credential hashes, grants, clients and expiry metadata, not raw access/refresh tokens. Short-lived credentials are returned to the requesting client; protect its storage and protect the database/backups. Authorization transaction data and task records may still be sensitive.

## Refresh, revocation and MCP sessions

Access-token TTL is configurable (default one hour). Refresh tokens rotate within a fixed thirty-day family lifetime. Spent refresh hashes are retained for replay detection; reuse revokes the grant family. `/revoke` revokes the corresponding grant. Resource is bound to `PUBLIC_BASE_URL/mcp` (issuer may be separately configured), and cannot be switched during exchange/refresh.

MCP sessions are bound to the authenticated principal/grant. A refreshed access token from the same grant can continue its session; a different grant cannot reuse it. Invalid credentials return HTTP 401 with discovery in `WWW-Authenticate`; unknown supplied session IDs return 404, while missing sessions on non-initialize messages remain 400.

Persistent OAuth credentials survive relay restart. MCP transports and owner browser sessions do not; clients must initialize/reopen as appropriate.

## Limits and operational guidance

- Public dynamic registration has no client authentication, for public-client compatibility. In-memory endpoint rate limits are defense-in-depth, not a distributed anti-abuse service.
- Single-owner grants allow access to the owner's registered projects; there is no separate per-project/user OAuth ACL or external identity provider.
- Use a stable HTTPS tunnel URL and trusted registered projects. Never tunnel the owner listener or raw app-server.
- Do not log/share authorization continuation links, codes, tokens or URL-token paths. Do not approve an unexpected request based only on a friendly client name.
- Automated tests cover consent bypass denial, persistence, PKCE/resource binding, rotation/replay/revocation and private-plane isolation. They do not establish conformance with every real ChatGPT account/UI.
- `npm run verify:public` is an opt-in external check. It waits for a real local owner decision, reads already granted projects and revokes its smoke grant; it never approves remotely or runs a task.
