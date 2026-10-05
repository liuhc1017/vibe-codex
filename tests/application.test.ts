import fs from "node:fs/promises";
import path from "node:path";
import { createServer, request, Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApplication } from "../src/index.js";
import { Config } from "../src/config/types.js";
import { initRunStore } from "../src/runs/runStore.js";
import { loadOwnerKey, readOwnerKey } from "../src/server/localControl.js";
import { tempConfig } from "./helpers.js";

vi.mock("../src/runs/runStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runs/runStore.js")>();
  return { ...actual, initRunStore: vi.fn(actual.initRunStore) };
});

vi.mock("../src/server/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/diagnostics.js")>();
  return { ...actual, collectDiagnostics: vi.fn(async (config: Config) => ({
    version: "test", status: "ready", checks: [], roots: [], warnings: [],
    codex: { available: true, loggedIn: true, executionReady: true },
    connector: actual.connectorSettings(config), localControlUrl: `http://127.0.0.1:${config.controlPort}`,
  })) };
});

let ctx: Awaited<ReturnType<typeof tempConfig>>;
const applications: Awaited<ReturnType<typeof startApplication>>[] = [];
const extraServers: Server[] = [];

async function listenOn(server: Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function unusedPort() {
  const server = createServer();
  const port = await listenOn(server);
  await closeServer(server);
  return port;
}

async function start() {
  const application = await startApplication(ctx.config);
  applications.push(application);
  return application;
}

async function openOwner(application: Awaited<ReturnType<typeof startApplication>>) {
  const response = await fetch(`${application.control.origin}/api/session`, {
    method: "POST", headers: { origin: application.control.origin, "content-type": "application/json" },
    body: JSON.stringify({ ticket: new URL(application.control.mintBootstrap()).hash.slice(1) }),
  });
  expect(response.status).toBe(200);
  return { cookie: response.headers.get("set-cookie")!.split(";")[0], csrf: (await response.json()).csrf as string };
}

beforeEach(async () => {
  ctx = await tempConfig();
  ctx.config.port = await unusedPort();
  do { ctx.config.controlPort = await unusedPort(); } while (ctx.config.controlPort === ctx.config.port);
  ctx.config.disableAuth = false;
  ctx.config.codexAppServerMode = "disabled";
  vi.mocked(initRunStore).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(extraServers.splice(0).map(closeServer));
  vi.restoreAllMocks();
  await ctx.cleanup();
});

describe("application lifecycle", () => {
  it("starts separate loopback listeners and preserves project/run state across a complete close and reopen", async () => {
    const first = await start();
    expect((first.httpServer.address() as AddressInfo).address).toBe("127.0.0.1");
    expect((first.controlServer.address() as AddressInfo).address).toBe("127.0.0.1");
    expect(first.controlServer.address()).not.toEqual(first.httpServer.address());
    expect((await fetch(`http://127.0.0.1:${ctx.config.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${ctx.config.port}/api/state`)).status).toBe(404);
    const owner = await openOwner(first);
    const key = await fs.readFile(path.join(ctx.config.ownerDataDir, "owner.key"), "utf8");
    const project = first.runStore.createProject({ name: "Persisted project", path: ctx.root });
    const run = first.runStore.createRun({ projectId: project.id, workspacePath: ctx.root, status: "completed", autonomy: "workspace", prompt: "Recorded task", command: "", stdout: "Recorded final answer" });
    await first.close();
    await first.close();
    expect(first.runStore.db.open).toBe(false);
    expect(first.httpServer.listening).toBe(false);
    expect(first.controlServer.listening).toBe(false);

    const second = await start();
    expect(await fs.readFile(path.join(ctx.config.ownerDataDir, "owner.key"), "utf8")).toBe(key);
    expect(second.runStore.getProject(project.id)?.name).toBe("Persisted project");
    expect(second.runStore.getRun(run.id)?.stdout).toBe("Recorded final answer");
    expect((await fetch(`${second.control.origin}/api/session`, { headers: { cookie: owner.cookie } })).status).toBe(401);
    const renewed = await openOwner(second);
    const state = await fetch(`${second.control.origin}/api/state`, { headers: { cookie: renewed.cookie } });
    expect(state.status).toBe(200);
    expect((await state.json()).runs[0].id).toBe(run.id);
    expect((await fs.stat(path.join(ctx.config.ownerDataDir, "control.json"))).mode & 0o077).toBe(0);
  });

  it("makes concurrent close callers await the same completed shutdown", async () => {
    const application = await start();
    const closing = application.close();
    try {
      await application.close();
      expect(application.runStore.db.open).toBe(false);
      expect(application.httpServer.listening).toBe(false);
      expect(application.controlServer.listening).toBe(false);
    } finally { await closing; }
  });

  for (const occupied of ["bridge", "control"] as const) {
    it(`cleans up the sibling listener and run database when the ${occupied} port is occupied`, async () => {
      const blocker = createServer();
      extraServers.push(blocker);
      const occupiedPort = occupied === "bridge" ? ctx.config.port : ctx.config.controlPort;
      const siblingPort = occupied === "bridge" ? ctx.config.controlPort : ctx.config.port;
      await listenOn(blocker, occupiedPort);
      await expect(start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(vi.mocked(initRunStore).mock.results.at(-1)?.value.db.open).toBe(false);
      const probe = createServer();
      extraServers.push(probe);
      expect(await listenOn(probe, siblingPort)).toBe(siblingPort);
      await closeServer(probe);
      await closeServer(blocker);
      const recovered = await start();
      expect(recovered.httpServer.listening).toBe(true);
      expect(recovered.controlServer.listening).toBe(true);
    });
  }

  it("closes an initialized MCP session and its open SSE stream before waiting for HTTP shutdown", async () => {
    const application = await start();
    const publicUrl = `http://127.0.0.1:${ctx.config.port}/mcp`;
    const headers = { authorization: "Bearer test", accept: "application/json, text/event-stream", "content-type": "application/json" };
    const initialized = await fetch(publicUrl, { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } },
    }) });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id")!;
    await initialized.text();
    const notified = await fetch(publicUrl, { method: "POST", headers: { ...headers, "mcp-session-id": sessionId }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notified.status).toBe(202);
    await notified.text();
    const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const client = request(publicUrl, { headers: { authorization: "Bearer test", accept: "text/event-stream", "mcp-session-id": sessionId } }, resolve);
      client.once("error", reject);
      client.end();
    });
    expect(stream.statusCode).toBe(200);
    const streamEnded = new Promise<void>((resolve) => { stream.once("end", resolve); stream.resume(); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([application.close(), streamEnded]),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("SSE shutdown did not finish")), 3000); }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); stream.destroy(); }
    expect(application.bridge.locals.mcpSessions.size).toBe(0);
    expect(application.runStore.db.open).toBe(false);
  });
});

describe("owner key filesystem validation", () => {
  it("creates one private durable key even for concurrent first opens", async () => {
    const keys = await Promise.all([loadOwnerKey(ctx.config.ownerDataDir), loadOwnerKey(ctx.config.ownerDataDir)]);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys[1]).toBe(keys[0]);
    expect((await fs.stat(path.join(ctx.config.ownerDataDir, "owner.key"))).mode & 0o077).toBe(0);
    expect((await fs.stat(ctx.config.ownerDataDir)).mode & 0o077).toBe(0);
  });

  it("does not create missing credentials when opening the workbench read-only", async () => {
    await expect(readOwnerKey(ctx.config.ownerDataDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(ctx.config.ownerDataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects exposed or symlinked owner directories without changing them", async () => {
    await fs.mkdir(ctx.config.ownerDataDir, { recursive: true, mode: 0o755 });
    await expect(loadOwnerKey(ctx.config.ownerDataDir)).rejects.toThrow(/private directory/);
    expect((await fs.stat(ctx.config.ownerDataDir)).mode & 0o077).toBe(0o055);
    await expect(fs.stat(path.join(ctx.config.ownerDataDir, "owner.key"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rmdir(ctx.config.ownerDataDir);
    const target = path.join(ctx.root, "private-owner-target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, ctx.config.ownerDataDir);
    await expect(loadOwnerKey(ctx.config.ownerDataDir)).rejects.toThrow(/private directory/);
    expect((await fs.lstat(ctx.config.ownerDataDir)).isSymbolicLink()).toBe(true);
    await expect(fs.stat(path.join(target, "owner.key"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked key without reading, replacing or changing its target", async () => {
    await fs.mkdir(ctx.config.ownerDataDir, { recursive: true, mode: 0o700 });
    const target = path.join(ctx.root, "other.key");
    await fs.writeFile(target, "A".repeat(43), { mode: 0o600 });
    await fs.symlink(target, path.join(ctx.config.ownerDataDir, "owner.key"));
    await expect(loadOwnerKey(ctx.config.ownerDataDir)).rejects.toThrow(/private regular file/);
    expect(await fs.readFile(target, "utf8")).toBe("A".repeat(43));
    expect((await fs.lstat(path.join(ctx.config.ownerDataDir, "owner.key"))).isSymbolicLink()).toBe(true);
  });

  it("rejects an exposed or malformed existing key instead of silently rotating it", async () => {
    await fs.mkdir(ctx.config.ownerDataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(ctx.config.ownerDataDir, "owner.key");
    await fs.writeFile(filename, "B".repeat(43), { mode: 0o644 });
    await expect(loadOwnerKey(ctx.config.ownerDataDir)).rejects.toThrow(/private regular file/);
    expect(await fs.readFile(filename, "utf8")).toBe("B".repeat(43));
    await fs.chmod(filename, 0o600);
    await fs.writeFile(filename, "invalid-key");
    await expect(loadOwnerKey(ctx.config.ownerDataDir)).rejects.toThrow(/invalid/);
    expect(await fs.readFile(filename, "utf8")).toBe("invalid-key");
  });
});
