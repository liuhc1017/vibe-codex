import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { startApplication } from "../src/index.js";
import { pkceS256 } from "../src/server/oauthStore.js";
import { runProcessArgv } from "../src/util/spawn.js";
import { tempConfig } from "../tests/helpers.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function request(url: string, init?: RequestInit) {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
}

async function json(response: Response, label: string): Promise<any> {
  // Never include OAuth/session response bodies in error messages.
  assert(response.ok, `${label}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  console.log("Live verification uses your Codex login and model quota in a disposable repository. It does not connect ChatGPT or modify existing project grants.");
  const ctx = await tempConfig();
  let application: Awaited<ReturnType<typeof startApplication>> | undefined;
  let sessionId: string | undefined;
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let clientId: string | undefined;
  const config = ctx.config;
  config.port = await freePort();
  config.controlPort = await freePort();
  config.codexAppServerPort = await freePort();
  Object.assign(config, {
    codexBin: process.env.CODEX_BIN || "codex", codexAppServerMode: "auto",
    codexModel: process.env.CODEX_MODEL?.trim() || undefined,
    disableAuth: false, developmentMode: false, relayToken: undefined,
    enableExperimentalOAuth: true, defaultCodexApproval: "on-request", codexTimeoutMs: 180_000,
  });
  const base = `http://127.0.0.1:${config.port}`;
  const owner = `http://127.0.0.1:${config.controlPort}`;
  config.publicBaseUrl = base;
  config.oauthIssuerBaseUrl = base;
  const resource = `${base}/mcp`;
  try {
    const workspace = path.join(ctx.root, "project");
    await fs.mkdir(workspace);
    const git = await runProcessArgv({ file: "git", args: ["init", workspace] });
    assert.equal(git.exitCode, 0, "Could not initialize disposable repository");
    // Do not log the one-use owner opening credential emitted by normal startup.
    const log = console.log;
    console.log = () => {};
    try { application = await startApplication(config); } finally { console.log = log; }

    const ticket = new URL(application.control.mintBootstrap()).hash.slice(1);
    const sessionResponse = await request(`${owner}/api/session`, {
      method: "POST", headers: { origin: owner, "content-type": "application/json" }, body: JSON.stringify({ ticket }),
    });
    const { csrf } = await json(sessionResponse, "Owner fixture session");
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
    assert(cookie, "Owner session cookie missing");
    const ownerHeaders = { origin: owner, cookie, "x-vibe-csrf": csrf, "content-type": "application/json" };
    const ownerPost = async (route: string, body: unknown) => json(await request(`${owner}${route}`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify(body),
    }), route);
    const { project } = await ownerPost("/api/projects", { name: "live-verification", workspacePath: workspace });
    const metadata = await json(await request(`${base}/.well-known/oauth-protected-resource`), "Resource discovery");
    assert.equal(metadata.resource, resource);
    const server = await json(await request(`${base}/.well-known/oauth-authorization-server`), "OAuth discovery");
    assert(server.grant_types_supported.includes("refresh_token"));
    const redirectUri = "https://chatgpt.com/aip/callback";
    const client = await json(await request(server.registration_endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Disposable live verification" }),
    }), "Client registration");
    clientId = client.client_id;
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: pkceS256(verifier), code_challenge_method: "S256", scope: "mcp", resource, state });
    const authorization = await request(`${server.authorization_endpoint}?${params}`);
    assert.equal(authorization.status, 200);
    const handle = (await authorization.text()).match(/\/authorize\/continue\?handle=([A-Za-z0-9_-]{43})/)?.[1];
    assert(handle, "Owner approval waiting page missing");
    const pending = application.bridge.locals.oauthStore.listAuthorizations().find((item: any) => item.clientId === client.client_id);
    assert(pending, "Fixture authorization missing");
    // Approve only this isolated fixture through the authenticated private owner API.
    await ownerPost(`/api/connections/${pending.id}`, { decision: "approve" });
    const continuation = await request(`${base}/authorize/continue?handle=${handle}`);
    assert.equal(continuation.status, 302);
    const callback = new URL(continuation.headers.get("location")!);
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
    assert.equal(callback.searchParams.get("state"), state);
    const token = await json(await request(server.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri,
        code: callback.searchParams.get("code")!, code_verifier: verifier, resource }),
    }), "Code exchange");
    assert(token.access_token && token.refresh_token, "Token pair missing");
    // Test refresh before executing tasks, as ChatGPT must reconnect after expiry.
    refreshToken = token.refresh_token;
    const refreshed = await json(await request(server.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: refreshToken!, resource }),
    }), "Token refresh");
    accessToken = refreshed.access_token;
    refreshToken = refreshed.refresh_token;
    assert(accessToken && refreshToken, "Refreshed token pair missing");

    let id = 0;
    async function mcp(method: string, params: unknown, notification = false): Promise<any> {
      const response = await request(resource, { method: "POST", headers: {
        authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      }, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params }) });
      assert(response.ok, `${method}: HTTP ${response.status}`);
      sessionId ??= response.headers.get("mcp-session-id") || undefined;
      const body = await response.text();
      if (notification) return;
      const data = body.split("\n").find((line) => line.startsWith("data: "));
      const payload = JSON.parse(data ? data.slice(6) : body);
      assert(!payload.error && !payload.result?.isError, `${method} returned an MCP error`);
      return payload.result;
    }
    const call = async (name: string, args: unknown) => (await mcp("tools/call", { name, arguments: args })).structuredContent;
    async function wait(runId: string, expected = "completed") {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const { run } = await call("get_run", { runId });
        if (["completed", "failed", "interrupted", "recovery_required", "waiting_approval", "waiting_input"].includes(run.status)) {
          assert.equal(run.status, expected, `Live turn ${runId}: ${run.status}; ${run.stderr || run.metadata?.recoveryReason || "inspect local Codex authentication/permissions"}`);
          return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Live turn timed out");
    }
    await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vibe-live-verification", version: "0.3.0" } });
    await mcp("notifications/initialized", {}, true);
    assert(sessionId, "MCP session missing");
    const tools = await mcp("tools/list", {});
    assert(tools.tools.some((tool: any) => tool.name === "start_project_task"));
    const projects = await call("list_projects", {});
    assert.equal(projects.projects.length, 1);
    const marker = `live-${randomBytes(12).toString("hex")}`;
    console.log("OAuth, owner project grant, refresh, MCP initialization and tool discovery passed. Starting real Codex file edit…");
    const first = await call("start_project_task", { projectRef: project.id,
      userGoal: `Create connection-proof.txt containing exactly ${marker} followed by a newline. Use apply_patch. Do not run commands, commit, push, or change other files. Reply with the marker when done.` });
    const firstRun = await wait(first.runId);
    assert.equal(await fs.readFile(path.join(workspace, "connection-proof.txt"), "utf8"), `${marker}\n`);
    const firstResult = await call("collect_project_result", { runId: first.runId });
    assert(firstResult.finalAnswer?.includes(marker), "Final answer missing from result");
    assert(firstResult.changedFiles.includes("connection-proof.txt"), "File edit missing from result");
    console.log("Real Codex file edit, completed status and collected final answer passed. Continuing the same thread…");
    const next = await call("continue_project_task", { projectRef: project.id,
      instruction: "Append a second line containing the exact previous marker with -continued appended. Use the marker from our previous conversation. Use apply_patch; do not run commands, commit, push, or change other files." });
    assert.equal(next.threadId, first.threadId, "Follow-up changed threads");
    const nextRun = await wait(next.runId);
    assert.equal(nextRun.metadata.parentRunId, firstRun.id, "Follow-up lineage missing");
    assert.equal(await fs.readFile(path.join(workspace, "connection-proof.txt"), "utf8"), `${marker}\n${marker}-continued\n`);
    const nextResult = await call("collect_project_result", { runId: next.runId });
    assert(nextResult.finalAnswer, "Follow-up final answer missing");
    console.log("Same-thread follow-up and actual file contents passed. Testing owner interruption…");
    const stopping = await call("continue_project_task", { projectRef: project.id,
      instruction: "Run sleep 60 once, wait for it to finish, then reply done. Do not modify any files or run other commands." });
    await ownerPost(`/api/runs/${stopping.runId}/interrupt`, {});
    await wait(stopping.runId, "interrupted");
    console.log(JSON.stringify({ ok: true, realCodex: true, oauth: true, tokenRefresh: true, mcp: true,
      fileEdit: true, sameThreadFollowup: true, finalAnswers: true, interruption: true,
      chatgptUiTested: false, publicTunnelTested: false }, null, 2));
  } finally {
    if (sessionId && accessToken) await request(resource, { method: "DELETE", headers: {
      authorization: `Bearer ${accessToken}`, "mcp-session-id": sessionId,
    } }).catch(() => undefined);
    if (refreshToken && clientId) await request(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, client_id: clientId }) }).catch(() => undefined);
    await application?.close();
    await ctx.cleanup();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Live verification failed"); process.exitCode = 1; });
