import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/loadConfig.js";
import { Config } from "./config/types.js";
import { initRunStore } from "./runs/runStore.js";
import { createMcpServer } from "./server/mcpServer.js";
import { createHttpApp, listen } from "./server/http.js";
import { createLocalControl, loadOwnerKey } from "./server/localControl.js";
import { OAuthStore } from "./server/oauthStore.js";
import { getRunCoordinator } from "./codex/runCoordinator.js";
import { stopManagedCodexAppServer } from "./codex/codexAppServerManager.js";
import { logger } from "./util/logger.js";
import { ApprovalStore } from "./approvals/actionPolicy.js";
import { AuthSessionStore } from "./server/authSessions.js";

export async function startApplication(config: Config = loadConfig()) {
  await fs.mkdir(path.dirname(config.databasePath), { recursive: true });
  const ownerKey = await loadOwnerKey(config.ownerDataDir);
  const runStore = initRunStore(config.databasePath);
  const approvals = new ApprovalStore(config.databasePath);
  const oauthStore = new OAuthStore(config.databasePath);
  const stores = { approvals, authSessions: new AuthSessionStore() };
  const coordinator = getRunCoordinator(config, runStore);
  const bridge = createHttpApp(config, () => createMcpServer(config, runStore, stores), stores.authSessions, oauthStore);
  const control = createLocalControl({ config, runStore, approvals, oauthStore, ownerKey });
  const controlServer = control.app.listen(config.controlPort, "127.0.0.1");
  const httpServer = listen(config, bridge);
  let closing: Promise<void> | undefined;

  function close() {
    return closing ??= (async () => {
      control.close();
      await coordinator.close();
      await bridge.locals.dispose();
      await Promise.all([controlServer, httpServer].map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      })));
      await stopManagedCodexAppServer(config).catch(() => undefined);
      oauthStore.close();
      approvals.close();
      runStore.db.close();
    })();
  }

  try {
    await Promise.all([controlServer, httpServer].map((server) => new Promise<void>((resolve, reject) => {
      if (server.listening) return resolve();
      server.once("listening", resolve);
      server.once("error", reject);
    })));
    await fs.writeFile(path.join(config.ownerDataDir, "control.json"), JSON.stringify({ origin: control.origin }, null, 2), { mode: 0o600 });
    console.log(`\nVibe Codex local workbench\n${control.mintBootstrap()}\n\nThis opening link expires in one minute. Run npm run open for a fresh link.\nTunnel the bridge on port ${config.port}, not the private workbench on ${config.controlPort}.\n`);
    void coordinator.reconcile().catch((error) => logger.warn("run_recovery_failed", { error: error instanceof Error ? error.message : String(error) }));
    return { config, bridge, control, httpServer, controlServer, runStore, coordinator, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  const application = await startApplication();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting_down");
    await application.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    logger.error("startup_failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
