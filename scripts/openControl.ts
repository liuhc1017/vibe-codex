import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/loadConfig.js";
import { runProcessArgv } from "../src/util/spawn.js";
import { readOwnerKey } from "../src/server/localControl.js";

try {
  const config = loadConfig();
  const manifest = JSON.parse(await fs.readFile(path.join(config.ownerDataDir, "control.json"), "utf8")) as { origin: string };
  const origin = new URL(manifest.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.port !== String(config.controlPort) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("The local workbench address is invalid. Restart Vibe Codex to recreate it.");
  }
  const key = await readOwnerKey(config.ownerDataDir);
  const response = await fetch(`${origin.origin}/api/bootstrap-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(3_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("The local workbench rejected this credential. Restart Vibe Codex and try again.");
  const { url } = await response.json() as { url: string };
  const opening = new URL(url);
  if (opening.origin !== origin.origin) throw new Error("The workbench returned an unexpected opening address.");
  console.log(`Local workbench (one-use link, valid for one minute):\n${url}`);
  if (!process.argv.includes("--print") && process.platform === "darwin") {
    await runProcessArgv({ file: "/usr/bin/open", args: [url], timeoutMs: 5_000, maxOutputBytes: 1_000 });
  }
} catch (error) {
  console.error(`Cannot open the local workbench: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Start Vibe Codex with npm run dev or npm start, then run npm run open again.");
  process.exitCode = 1;
}
