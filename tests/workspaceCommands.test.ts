import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorkspaceCommand } from "../src/workspace/commands.js";
import { tempConfig } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
beforeEach(async () => { ctx = await tempConfig(); });
afterEach(async () => { await ctx.cleanup(); });

const run = (command: string, autonomy: "workspace" | "build-test" = "workspace") => runWorkspaceCommand({ workspacePath: ctx.root, command, autonomy, config: ctx.config });

describe("workspace argv execution", () => {
  it("does not execute prefix-allowlist bypasses", async () => {
    for (const command of ["git status; touch marker", "ls && touch marker", "npm test > marker", "find . -maxdepth 1 -type f -exec touch marker"]) {
      const result = await run(command).catch((error) => ({ executed: false, code: error.code }));
      expect(result.executed).toBe(false);
    }
    await expect(fs.stat(path.join(ctx.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("executes quoted arguments as argv, preserving spaces", async () => {
    await fs.writeFile(path.join(ctx.root, "file with spaces.txt"), "hi");
    const result = await run("ls 'file with spaces.txt'");
    expect(result.executed).toBe(true);
    expect(result.stdout).toContain("file with spaces.txt");
  });
  it("validates secret, outside, and symlink path operands", async () => {
    await fs.writeFile(path.join(ctx.root, "normal.txt"), "hi");
    await fs.symlink("normal.txt", path.join(ctx.root, "link.txt"));
    await expect(run("ls .env")).rejects.toMatchObject({ code: "SENSITIVE_PATH_BLOCKED" });
    await expect(run("ls /etc/passwd")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
    await expect(run("ls link.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
    await expect(run("git diff -- ../outside")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
    await expect(run("find link.txt/.. -maxdepth 1 -type f")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });
  it("requires build-test autonomy before executing repository scripts", async () => {
    await fs.writeFile(path.join(ctx.root, "package.json"), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'built.txt\',\'yes\')"' } }));
    const denied = await run("npm test");
    expect(denied.executed).toBe(false);
    expect(denied.risk).toBe("normal");
    await expect(fs.stat(path.join(ctx.root, "built.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const allowed = await run("npm test", "build-test");
    expect(allowed.executed).toBe(true);
    expect(allowed.exitCode).toBe(0);
    await expect(fs.readFile(path.join(ctx.root, "built.txt"), "utf8")).resolves.toBe("yes");
  });
});
