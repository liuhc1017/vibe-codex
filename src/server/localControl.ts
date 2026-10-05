import express from "express";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Config } from "../config/types.js";
import { RunStore } from "../runs/runStore.js";
import { ApprovalStore } from "../approvals/actionPolicy.js";
import { OAuthStore } from "./oauthStore.js";
import { getRunCoordinator } from "../codex/runCoordinator.js";
import { startProjectTask, continueProjectTask } from "../codex/projectTasks.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { gitIsRepository } from "../workspace/git.js";
import { collectRunResult } from "../runs/results.js";
import { constantTimeEqual } from "../util/crypto.js";
import { collectDiagnostics } from "./diagnostics.js";
import { controlHtml, controlCss, controlJs } from "./controlPage.js";

export async function readOwnerKey(directory: string) {
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("Owner data must be a private directory (mode 0700), not a symlink.");
  }
  const filename = path.join(directory, "owner.key");
  // Open without following a symlink; validate the same file descriptor we read.
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw new Error("Owner key must be a private regular file (mode 0600), not a symlink.");
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 100) {
      throw new Error("Owner key must be a private regular file (mode 0600), not a symlink.");
    }
    const key = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Owner key is invalid. Restore a valid private owner key before starting.");
    return key;
  } finally {
    await handle.close();
  }
}

export async function loadOwnerKey(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await readOwnerKey(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32).toString("base64url");
    const temporary = path.join(directory, `.owner-key-${randomBytes(16).toString("hex")}`);
    await fs.writeFile(temporary, key, { flag: "wx", mode: 0o600 });
    try {
      // Publish a complete file atomically, without overwriting a concurrent key.
      await fs.link(temporary, path.join(directory, "owner.key"));
      return key;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      return readOwnerKey(directory);
    } finally {
      await fs.unlink(temporary);
    }
  }
}

type OwnerSession = { csrf: string; expiresAt: number };

export function createLocalControl(args: { config: Config; runStore: RunStore; approvals: ApprovalStore; oauthStore: OAuthStore; ownerKey: string }) {
  const { config, runStore, approvals, oauthStore, ownerKey } = args;
  const coordinator = getRunCoordinator(config, runStore);
  const app = express();
  const sessions = new Map<string, OwnerSession>();
  const tickets = new Map<string, number>();
  const origin = `http://127.0.0.1:${config.controlPort}`;
  const expectedHost = `127.0.0.1:${config.controlPort}`;
  let diagnostics: Awaited<ReturnType<typeof collectDiagnostics>> | undefined;
  let diagnosticsAt = 0;
  let diagnosticsPending: Promise<Awaited<ReturnType<typeof collectDiagnostics>>> | undefined;

  function mintBootstrap() {
    const now = Date.now();
    for (const [ticket, expiry] of tickets) if (expiry <= now) tickets.delete(ticket);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, now + 60_000);
    return `${origin}/#${ticket}`;
  }

  function session(req: express.Request) {
    const id = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("vibe_owner="))?.slice("vibe_owner=".length);
    const current = id ? sessions.get(id) : undefined;
    if (!current || current.expiresAt <= Date.now()) {
      if (id) sessions.delete(id);
      return undefined;
    }
    return current;
  }

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.headers.host !== expectedHost || req.headers["x-forwarded-host"] || req.headers["x-forwarded-for"] || req.headers["x-forwarded-proto"]) {
      return res.status(403).json({ error: "Open the control page directly on 127.0.0.1, not through a tunnel or proxy." });
    }
    if (req.headers.origin && req.headers.origin !== origin) return res.status(403).json({ error: "Unexpected origin." });
    if (!["GET", "HEAD"].includes(req.method) && req.path !== "/api/bootstrap-ticket" && req.headers.origin !== origin) {
      return res.status(403).json({ error: "An exact local Origin is required." });
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.get("/", (_req, res) => res.type("html").send(controlHtml));
  app.get("/control.css", (_req, res) => res.type("css").send(controlCss));
  app.get("/control.js", (_req, res) => res.type("js").send(controlJs));

  app.post("/api/bootstrap-ticket", (req, res) => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!constantTimeEqual(bearer, ownerKey)) return res.status(401).json({ error: "Owner credential required." });
    res.json({ url: mintBootstrap() });
  });
  app.post("/api/session", (req, res) => {
    const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
    const expiry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!expiry || expiry <= Date.now()) return res.status(401).json({ error: "This opening link expired or was already used. Run npm run open to get a new one." });
    const id = randomBytes(32).toString("base64url");
    const current = { csrf: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 8 * 60 * 60_000 };
    sessions.set(id, current);
    res.setHeader("Set-Cookie", `vibe_owner=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    res.json({ csrf: current.csrf });
  });
  app.use("/api", (req, res, next) => {
    const current = session(req);
    if (!current) return res.status(401).json({ error: "Open a fresh local session with npm run open." });
    if (!["GET", "HEAD"].includes(req.method) && !constantTimeEqual(req.header("x-vibe-csrf"), current.csrf)) {
      return res.status(403).json({ error: "Session verification failed. Reload the page." });
    }
    next();
  });
  app.get("/api/session", (req, res) => res.json({ csrf: session(req)!.csrf }));
  app.post("/api/logout", (req, res) => {
    const id = req.headers.cookie?.match(/(?:^|;\s*)vibe_owner=([^;]+)/)?.[1];
    if (id) sessions.delete(id);
    res.setHeader("Set-Cookie", "vibe_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    void fn(req, res).catch(next);
  };
  const string = (value: unknown, name: string) => {
    if (typeof value !== "string" || !value.trim() || value.length > 40_000) throw new Error(`${name} is required and must be less than 40,000 characters.`);
    return value;
  };

  app.get("/api/state", route(async (_req, res) => {
    if (!diagnostics || Date.now() - diagnosticsAt > 15_000) {
      diagnosticsPending ??= collectDiagnostics(config).then((value) => {
        diagnostics = value;
        diagnosticsAt = Date.now();
        return value;
      }).finally(() => { diagnosticsPending = undefined; });
      await diagnosticsPending;
    }
    res.json({ diagnostics, projects: runStore.listProjects(), runs: runStore.listRuns().slice(0, 50), approvals: approvals.list("pending"), connections: oauthStore.listAuthorizations(), requests: coordinator.pendingRequests() });
  }));
  app.post("/api/projects", route(async (req, res) => {
    const workspacePath = await assertSafeWorkspacePath(string(req.body.workspacePath, "Project path"), config);
    if (!(await gitIsRepository(workspacePath, config))) throw new Error("Choose an existing Git repository inside an allowed folder.");
    const project = runStore.createProject({ name: string(req.body.name, "Project name"), path: workspacePath, preferredExecutionMode: "codex-app-thread" });
    res.json({ project });
  }));
  app.post("/api/tasks", route(async (req, res) => {
    const projectRef = string(req.body.projectRef, "Project");
    const instruction = string(req.body.instruction, "Task");
    const run = req.body.continue === true
      ? await continueProjectTask(config, runStore, { projectRef, instruction })
      : await startProjectTask(config, runStore, { projectRef, userGoal: instruction });
    res.json({ run });
  }));
  app.get("/api/runs/:id/result", route(async (req, res) => res.json(await collectRunResult(config, runStore, String(req.params.id)))));
  app.post("/api/runs/:id/interrupt", route(async (req, res) => res.json({ run: await coordinator.interrupt(String(req.params.id)) })));
  app.post("/api/runs/:id/reconcile", route(async (req, res) => {
    await coordinator.reconcile(String(req.params.id));
    res.json({ run: runStore.getRun(String(req.params.id)) });
  }));
  app.post("/api/approvals/:id", (req, res) => {
    const record = req.body.decision === "approve" ? approvals.approve(String(req.params.id)) : req.body.decision === "reject" ? approvals.reject(String(req.params.id)) : null;
    if (!record) return res.status(400).json({ error: "This decision expired or was already handled." });
    res.json({ approval: record });
  });
  app.post("/api/connections/:id", (req, res) => {
    if (!["approve", "reject"].includes(req.body.decision)) return res.status(400).json({ error: "Choose approve or reject." });
    const result = oauthStore.decideAuthorization(String(req.params.id), req.body.decision);
    res.status(result.ok ? 200 : 400).json(result);
  });
  app.post("/api/requests/:id", route(async (req, res) => {
    await coordinator.respond(String(req.params.id), req.body.result);
    res.json({ ok: true });
  }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error.message });
  });

  const cleanup = setInterval(() => {
    for (const [key, expiry] of tickets) if (expiry <= Date.now()) tickets.delete(key);
    for (const [key, current] of sessions) if (current.expiresAt <= Date.now()) sessions.delete(key);
  }, 60_000);
  cleanup.unref();
  return { app, origin, mintBootstrap, close: () => { clearInterval(cleanup); sessions.clear(); tickets.clear(); } };
}
