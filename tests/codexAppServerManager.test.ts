import fs from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectManagedCodexAppServer, startManagedCodexAppServer, stopManagedCodexAppServer } from "../src/codex/codexAppServerManager.js";
import { tempConfig } from "./helpers.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function writeFakeCodexBin(root: string) {
  const file = path.join(root, "fake-codex");
  await fs.writeFile(file, `#!/usr/bin/env node
const http = require("node:http");
const { createRequire } = require("node:module");
const requireFromCwd = createRequire(process.cwd() + "/package.json");
const { WebSocketServer } = requireFromCwd("ws");
const listenArg = process.argv[process.argv.indexOf("--listen") + 1];
const url = new URL(listenArg);
const server = http.createServer((req, res) => {
  const send = (payload) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) return send({ status: "ok" });
  return send({ ok: true, url: req.url });
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString("utf8"));
    if (request.id) socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
  });
});
server.listen(Number(url.port), url.hostname);
process.on("SIGTERM", () => wss.close(() => server.close(() => process.exit(0))));
`);
  await fs.chmod(file, 0o755);
  return file;
}

describe("Codex app-server manager", () => {
  it("detects a missing server without starting one", async () => {
    const ctx = await tempConfig();
    try {
      ctx.config.codexAppServerMode = "auto";
      ctx.config.codexAppServerAutostart = false;
      ctx.config.codexAppServerPort = await freePort();
      const status = await detectManagedCodexAppServer(ctx.config);
      expect(status.available).toBe(false);
      expect(status.startedByVibeCodex).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  it("starts a fake local app-server and reports managed status", async () => {
    const ctx = await tempConfig();
    try {
      ctx.config.codexAppServerMode = "auto";
      ctx.config.codexAppServerPort = await freePort();
      ctx.config.codexBin = await writeFakeCodexBin(ctx.root);
      const status = await startManagedCodexAppServer(ctx.config);
      expect(status.available).toBe(true);
      expect(status.startedByVibeCodex).toBe(true);
      expect(status.url).toBe(`ws://127.0.0.1:${ctx.config.codexAppServerPort}`);
      expect(status.pid).toBeGreaterThan(0);
      expect(status.details).toMatchObject({ isolatedMcpServers: true });
      const stopped = await stopManagedCodexAppServer(ctx.config);
      expect(stopped.available).toBe(false);
    } finally {
      await stopManagedCodexAppServer(ctx.config).catch(() => undefined);
      await ctx.cleanup();
    }
  });

  it("prefers explicit readiness failure over healthy liveness", async () => {
    const ctx = await tempConfig();
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(req.url === "/readyz" ? 503 : 200);
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      ctx.config.codexAppServerMode = "manual";
      ctx.config.codexAppServerUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      const result = await detectManagedCodexAppServer(ctx.config);
      expect(result.available).toBe(false);
      expect(requests).toEqual(["/readyz"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.cleanup();
    }
  });

  it("bounds probes when a server never responds", async () => {
    const ctx = await tempConfig();
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      ctx.config.codexAppServerMode = "manual";
      ctx.config.codexAppServerUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      const start = Date.now();
      expect((await detectManagedCodexAppServer(ctx.config)).available).toBe(false);
      expect(Date.now() - start).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.cleanup();
    }
  });

  it("coalesces concurrent starts and escalates a SIGTERM-ignoring server", async () => {
    const ctx = await tempConfig();
    try {
      ctx.config.codexAppServerMode = "auto";
      ctx.config.codexAppServerPort = await freePort();
      const binary = path.join(ctx.root, "ignore-term-codex");
      await fs.writeFile(binary, `#!/usr/bin/env node\nconst http=require('http');const url=new URL(process.argv[process.argv.indexOf('--listen')+1]);http.createServer((req,res)=>res.end('{"status":"ok"}')).listen(Number(url.port),url.hostname);process.on('SIGTERM',()=>{});`, { mode: 0o755 });
      ctx.config.codexBin = binary;
      const [first, second] = await Promise.all([startManagedCodexAppServer(ctx.config), startManagedCodexAppServer(ctx.config)]);
      expect(first.pid).toBe(second.pid);
      expect(first.details?.loginStatus).toBe("unknown");
      const stopped = await stopManagedCodexAppServer(ctx.config);
      expect(stopped.available).toBe(false);
      expect(() => process.kill(first.pid!, 0)).toThrow();
    } finally {
      await stopManagedCodexAppServer(ctx.config).catch(() => undefined);
      await ctx.cleanup();
    }
  }, 8_000);

  it("refuses public app-server hosts by default", async () => {
    const ctx = await tempConfig();
    try {
      ctx.config.codexAppServerMode = "auto";
      ctx.config.codexAppServerHost = "0.0.0.0";
      await expect(startManagedCodexAppServer(ctx.config)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    } finally {
      await ctx.cleanup();
    }
  });
});
