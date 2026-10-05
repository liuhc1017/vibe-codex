import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLaunchAgentPlist, launchAgentEnvironment } from "../scripts/installLaunchAgents.js";
import { runProcessArgv } from "../src/util/spawn.js";
import { tempConfig } from "./helpers.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ctx: Awaited<ReturnType<typeof tempConfig>>;
let repo: string;
let bin: string;
beforeEach(async () => {
  ctx = await tempConfig();
  repo = path.join(ctx.root, "portable repo & spaces");
  bin = path.join(ctx.root, "bin");
  await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
  await fs.mkdir(bin);
  for (const script of ["start-vibe-codex-service.sh", "start-vibe-codex-ngrok.sh"]) await fs.copyFile(path.join(sourceRoot, "scripts", script), path.join(repo, "scripts", script));
});
afterEach(async () => { await ctx.cleanup(); });

describe("portable launch scripts", () => {
  it("derives the relocated repo and uses PATH/configured Node without forcing development mode", async () => {
    const log = path.join(ctx.root, "service.log");
    await fs.writeFile(path.join(bin, "npm"), `#!/bin/bash\nprintf '%s\\n' "$PWD" "$*" >> '${log}'\n`, { mode: 0o700 });
    await fs.writeFile(path.join(bin, "node"), `#!/bin/bash\nprintf '%s\\n' "$PWD" "$*" "dev=\${VIBE_CODEX_DEV-unset}" >> '${log}'\n`, { mode: 0o700 });
    const result = await runProcessArgv({ file: "/bin/bash", args: [path.join(repo, "scripts", "start-vibe-codex-service.sh")], env: { PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: path.join(bin, "node"), VIBE_CODEX_DEV: undefined, VIBE_CODEX_REPO_DIR: undefined }, timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    const text = await fs.readFile(log, "utf8");
    expect(text).toContain(repo);
    expect(text).toContain("run build");
    expect(text).toContain("dist/src/index.js");
    expect(text).toContain("dev=unset");
  });
  it("parses quoted dotenv as data, honors env port override, and waits on /health before tunneling", async () => {
    const log = path.join(ctx.root, "tunnel.log");
    const marker = path.join(ctx.root, "should-not-exist");
    await fs.symlink(path.join(sourceRoot, "node_modules"), path.join(repo, "node_modules"));
    await fs.writeFile(path.join(repo, ".env"), `PUBLIC_BASE_URL="https://relay.example.invalid/path?x=a=b"\nPORT="9999"\nEVIL=$(touch '${marker}')\n`);
    await fs.writeFile(path.join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o700 });
    await fs.writeFile(path.join(bin, "ngrok"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o700 });
    const result = await runProcessArgv({ file: "/bin/bash", args: [path.join(repo, "scripts", "start-vibe-codex-ngrok.sh")], env: { PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: process.execPath, PORT: "9444", PUBLIC_BASE_URL: undefined, VIBE_CODEX_REPO_DIR: undefined }, timeoutMs: 5_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    const text = await fs.readFile(log, "utf8");
    expect(text).toContain("http://127.0.0.1:9444/health");
    expect(text).not.toContain("well-known");
    expect(text).toContain("http --url=https://relay.example.invalid http://127.0.0.1:9444");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("fails closed on invalid tunnel configuration without starting ngrok", async () => {
    await fs.symlink(path.join(sourceRoot, "node_modules"), path.join(repo, "node_modules"));
    await fs.writeFile(path.join(bin, "ngrok"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const result = await runProcessArgv({ file: "/bin/bash", args: [path.join(repo, "scripts", "start-vibe-codex-ngrok.sh")], env: { PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: process.execPath, PORT: "0", PUBLIC_BASE_URL: "https://relay.example.invalid", VIBE_CODEX_REPO_DIR: undefined }, timeoutMs: 5_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PORT must be between");
  });
  it("escapes XML and captures portable runtime paths without adding dev flags", () => {
    const root = "/tmp/a & b";
    const env = { PATH: "/custom/bin", NODE_BIN: "/custom/node/bin/node", PORT: "9333", PUBLIC_BASE_URL: "https://example.invalid/?a=1&b=2" };
    expect(launchAgentEnvironment(root, env).PATH).toContain("/custom/node/bin:/custom/bin");
    const text = buildLaunchAgentPlist({ label: "test", script: `${root}/scripts/start.sh`, stdout: `${root}/out`, stderr: `${root}/err` }, root, env);
    expect(text).toContain("/tmp/a &amp; b/scripts/start.sh");
    expect(text).toContain("a=1&amp;b=2");
    expect(text).toContain("<string>/bin/bash</string>");
    expect(text).not.toContain("VIBE_CODEX_DEV");
    expect(text).toContain("<string>9333</string>");
  });
});
