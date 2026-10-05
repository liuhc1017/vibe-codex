import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/loadConfig.js";

function parseMcpResponse(text: string): any {
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text);
}

async function request(url: string, init?: RequestInit) {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
}

function expectOk(response: Response, label: string) {
  // Do not print response bodies: OAuth codes/tokens may be present.
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}. Check the tunnel and local workbench.`);
}

async function main() {
  const config = loadConfig();
  const base = config.publicBaseUrl?.replace(/\/+$/, "");
  if (!base || !config.enableExperimentalOAuth) throw new Error("Set PUBLIC_BASE_URL and ENABLE_EXPERIMENTAL_OAUTH=true before running this optional public check.");
  const resource = `${base}/mcp`;
  const metadataResponse = await request(`${base}/.well-known/oauth-protected-resource`);
  expectOk(metadataResponse, "Resource discovery");
  const metadata = await metadataResponse.json() as any;
  if (metadata.resource !== resource) throw new Error("Unexpected protected resource.");
  const issuer = metadata.authorization_servers?.[0];
  if (typeof issuer !== "string" || issuer !== (config.oauthIssuerBaseUrl || base).replace(/\/+$/, "")) throw new Error("Unexpected OAuth issuer.");
  const serverResponse = await request(`${issuer}/.well-known/oauth-authorization-server`);
  expectOk(serverResponse, "Authorization discovery");
  const server = await serverResponse.json() as any;
  for (const [key, suffix] of [["registration_endpoint", "register"], ["authorization_endpoint", "authorize"], ["token_endpoint", "token"], ["revocation_endpoint", "revoke"]]) {
    if (server[key] !== `${issuer}/${suffix}`) throw new Error(`Unexpected ${key}.`);
  }
  const redirectUri = "https://chatgpt.com/connector/oauth/vibe-codex-public-smoke";
  const registration = await request(server.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Vibe Codex public smoke" }),
  });
  expectOk(registration, "Client registration");
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    scope: "mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource, state });
  const authorize = await request(`${server.authorization_endpoint}?${params}`);
  expectOk(authorize, "Authorization request");
  const html = await authorize.text();
  const handle = html.match(/\/authorize\/continue\?handle=([A-Za-z0-9_-]{43})/)?.[1];
  if (!handle) throw new Error("Authorization did not return an owner-approval waiting page.");
  console.log("Open the private workbench with npm run open. Approve the ‘Vibe Codex public smoke’ connection only if you initiated this check.");
  const deadline = Date.now() + 10 * 60_000;
  let code: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const continuation = await request(`${issuer}/authorize/continue?handle=${handle}`);
    if ([302, 303].includes(continuation.status)) {
      const location = continuation.headers.get("location");
      if (!location) throw new Error("Authorization continuation has no redirect.");
      const callback = new URL(location);
      if (`${callback.origin}${callback.pathname}` !== redirectUri || callback.searchParams.get("state") !== state) throw new Error("Authorization callback did not match this transaction.");
      if (callback.searchParams.has("error")) throw new Error("The connection was declined or expired.");
      code = callback.searchParams.get("code") || undefined;
      break;
    }
    expectOk(continuation, "Awaiting local decision");
    await continuation.text();
  }
  if (!code) throw new Error("Timed out waiting for the local owner's decision.");
  const tokenResponse = await request(server.token_endpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource }),
  });
  expectOk(tokenResponse, "Code exchange");
  const token = await tokenResponse.json() as { access_token: string; refresh_token: string };
  if (!token.access_token || !token.refresh_token) throw new Error("Malformed token response.");
  let sessionId: string | undefined;
  const headers = { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  let id = 0;
  async function mcp(method: string, params: unknown, notification = false) {
    const response = await request(resource, { method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params }) });
    expectOk(response, method);
    sessionId ??= response.headers.get("mcp-session-id") || undefined;
    const body = await response.text();
    return notification ? undefined : parseMcpResponse(body);
  }
  try {
    await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vibe-public-smoke", version: "0.3.0" } });
    if (!sessionId) throw new Error("No MCP session returned.");
    await mcp("notifications/initialized", {}, true);
    const tools = await mcp("tools/list", {});
    const names = new Set(tools.result.tools.map((tool: any) => tool.name));
    for (const name of ["relay_health", "list_projects", "start_project_task", "collect_project_result"]) if (!names.has(name)) throw new Error(`Missing tool: ${name}`);
    const resources = await mcp("resources/list", {});
    const projects = await mcp("tools/call", { name: "list_projects", arguments: {} });
    if (projects.result.isError) throw new Error("Could not list locally granted projects.");
    console.log(JSON.stringify({ ok: true, tools: names.size, resources: resources.result.resources.length,
      registeredProjects: projects.result.structuredContent.projects.length,
      note: "Public OAuth/MCP handshake verified. No project registered or Codex task executed; this is not a ChatGPT UI test." }, null, 2));
  } finally {
    if (sessionId) await request(resource, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId } }).catch(() => undefined);
    await request(server.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: token.refresh_token, client_id: client.client_id }) }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Public verification failed.");
  process.exitCode = 1;
});
