import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWorkspaceChanges, gitDiff, gitStatus, parseGitShortStatus, parseGitStatus } from "../src/workspace/git.js";
import { runProcessArgv } from "../src/util/spawn.js";
import { tempConfig } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let workspace: string;
async function git(...args: string[]) {
  const result = await runProcessArgv({ file: "git", args, cwd: workspace });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result;
}
beforeEach(async () => {
  ctx = await tempConfig();
  workspace = path.join(ctx.root, "workspace");
  await fs.mkdir(workspace);
  await git("init");
  await git("config", "user.email", "tests@example.invalid");
  await git("config", "user.name", "Tests");
});
afterEach(async () => { await ctx.cleanup(); });

describe("safe Git change collection", () => {
  it("parses NUL status without trimming XY or filename whitespace, including renames", () => {
    expect(parseGitStatus(' M file with spaces\0R  renamed\nfile\0original -> file\0??  leading.txt\0')).toEqual([
      { indexStatus: " ", worktreeStatus: "M", path: "file with spaces" },
      { indexStatus: "R", worktreeStatus: " ", path: "renamed\nfile", originalPath: "original -> file" },
      { indexStatus: "?", worktreeStatus: "?", path: " leading.txt" },
    ]);
    expect(() => parseGitStatus(" M incomplete")).toThrow();
    expect(() => parseGitStatus("R  destination\0")).toThrow();
    expect(parseGitShortStatus(' M "file with spaces"\nR  "original -> file" -> "renamed\\nfile"\n')).toEqual([
      { indexStatus: " ", worktreeStatus: "M", path: "file with spaces" },
      { indexStatus: "R", worktreeStatus: " ", path: "renamed\nfile", originalPath: "original -> file" },
    ]);
  });
  it("includes staged, unstaged and untracked changes with exact filenames", async () => {
    await fs.writeFile(path.join(workspace, "tracked file.txt"), "original\n");
    await fs.writeFile(path.join(workspace, "old name.txt"), "renamed content\n");
    await git("add", "."); await git("commit", "-m", "baseline");
    await fs.writeFile(path.join(workspace, "tracked file.txt"), "staged content\n");
    await git("add", "tracked file.txt");
    await fs.writeFile(path.join(workspace, "tracked file.txt"), "unstaged content\n");
    await git("mv", "old name.txt", "new name.txt");
    await fs.writeFile(path.join(workspace, " leading\nfile.txt"), "new content\n");
    const result = await collectWorkspaceChanges(workspace, ctx.config);
    expect(result.changedFiles).toEqual(expect.arrayContaining(["tracked file.txt", "new name.txt", " leading\nfile.txt"]));
    expect(result.gitDiffSummary).toContain("+staged content");
    expect(result.gitDiffSummary).toContain("+unstaged content");
    expect(result.gitDiffSummary).toContain("+new content");
    expect(parseGitShortStatus(result.gitStatus).map((entry) => entry.path)).toEqual(result.changedFiles);
    expect(result.gitStatus).not.toContain("\0");
    expect((await gitStatus(workspace, ctx.config)).stdout).toBe(result.gitStatus);
    expect((await gitDiff(workspace, ctx.config)).stdout).toBe(result.gitDiffSummary);
  });
  it("omits tracked/untracked secrets, symlinks, artifacts and secret renames", async () => {
    await fs.writeFile(path.join(workspace, ".env"), "TOP_SECRET_BASE\n");
    await fs.writeFile(path.join(workspace, "safe.txt"), "old\n");
    await git("add", "."); await git("commit", "-m", "baseline");
    await git("mv", ".env", "renamed-public.txt");
    await git("config", "status.renames", "false");
    await fs.writeFile(path.join(workspace, "credentials.json"), "TOP_SECRET_NEW");
    await fs.symlink("credentials.json", path.join(workspace, "leaky-link"));
    await fs.mkdir(path.join(workspace, ".vibe-codex"));
    await fs.writeFile(path.join(workspace, ".vibe-codex", "private-log"), "TOP_SECRET_LOG");
    await fs.writeFile(path.join(workspace, "safe.txt"), "public change\n");
    const result = await collectWorkspaceChanges(workspace, ctx.config);
    expect(result.changedFiles).toEqual(["safe.txt"]);
    expect(result.omittedFiles).toEqual(expect.arrayContaining(["renamed-public.txt", "credentials.json", "leaky-link", ".vibe-codex/private-log"]));
    expect(result.gitDiffSummary).toContain("public change");
    expect(result.gitDiffSummary).not.toContain("TOP_SECRET");
  });
  it("prevents textconv and external diff execution and treats pathspec-looking names literally", async () => {
    const marker = path.join(ctx.root, "external-ran");
    const hook = path.join(ctx.root, "hook.sh");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nprintf SECRET_FROM_FILTER\n`, { mode: 0o700 });
    await fs.writeFile(path.join(workspace, ".gitattributes"), "*.txt diff=evil\n");
    await fs.writeFile(path.join(workspace, "safe.txt"), "before\n");
    await git("add", "."); await git("commit", "-m", "baseline");
    await git("config", "diff.evil.textconv", hook);
    await git("config", "diff.external", hook);
    await fs.writeFile(path.join(workspace, "safe.txt"), "after\n");
    await fs.writeFile(path.join(workspace, ":(top)literal.txt"), "literal new\n");
    const result = await collectWorkspaceChanges(workspace, ctx.config);
    expect(result.gitDiffSummary).toContain("+after");
    expect(result.gitDiffSummary).toContain("literal new");
    expect(result.gitDiffSummary).not.toContain("SECRET_FROM_FILTER");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not expose indexed symlinks after they are replaced in the working tree", async () => {
    await fs.symlink("/etc/passwd", path.join(workspace, "indexed-link"));
    await git("add", "."); await git("commit", "-m", "baseline");
    await fs.unlink(path.join(workspace, "indexed-link"));
    await fs.writeFile(path.join(workspace, "indexed-link"), "regular now\n");
    const result = await collectWorkspaceChanges(workspace, ctx.config);
    expect(result.changedFiles).toEqual([]);
    expect(result.omittedFiles).toContain("indexed-link");
    expect(result.gitDiffSummary).not.toContain("/etc/passwd");
  });

  it("preserves git diff --check failures rather than claiming a successful status exit", async () => {
    await fs.writeFile(path.join(workspace, "whitespace.txt"), "before\n");
    await git("add", "."); await git("commit", "-m", "baseline");
    await fs.writeFile(path.join(workspace, "whitespace.txt"), "after   \n");
    const result = await gitDiff(workspace, ctx.config, 10_000, { flags: ["--check"] });
    const raw = await runProcessArgv({ file: "git", args: ["diff", "--check"], cwd: workspace });
    expect(result.exitCode).toBe(raw.exitCode);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("trailing whitespace");
  });

  it("restricts status/diffs to the actual workspace when it is a repository subdirectory", async () => {
    await fs.writeFile(path.join(workspace, "outside.txt"), "OUTSIDE\n");
    await fs.mkdir(path.join(workspace, "subdir"));
    await fs.writeFile(path.join(workspace, "subdir", "inside.txt"), "INSIDE\n");
    const result = await collectWorkspaceChanges(path.join(workspace, "subdir"), ctx.config);
    expect(result.changedFiles).toEqual(["inside.txt"]);
    expect(result.gitDiffSummary).not.toContain("OUTSIDE");
  });
  it("bounds bytes for multibyte tracked output and omits large/binary untracked files", async () => {
    await fs.writeFile(path.join(workspace, "tracked.txt"), "before\n");
    await git("add", "."); await git("commit", "-m", "baseline");
    await fs.writeFile(path.join(workspace, "tracked.txt"), "界".repeat(1000));
    await fs.writeFile(path.join(workspace, "large.txt"), "x".repeat(1000));
    await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
    const result = await collectWorkspaceChanges(workspace, ctx.config, 100);
    expect(Buffer.byteLength(result.gitDiffSummary)).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
    expect(result.omittedFiles).toContain("large.txt");
    const full = await collectWorkspaceChanges(workspace, ctx.config, 10_000);
    expect(full.omittedFiles).toContain("binary.bin");
  });
});
