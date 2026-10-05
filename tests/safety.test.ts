import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeFilePath, assertSafeWorkspacePath, isSensitivePath } from "../src/safety/paths.js";
import { tempConfig } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;

beforeEach(async () => {
  ctx = await tempConfig();
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("path safety", () => {
  it("allows paths inside an allowed root", async () => {
    const workspace = path.join(ctx.root, "project");
    await fs.mkdir(workspace);
    const resolved = await assertSafeWorkspacePath(workspace, ctx.config);
    expect(resolved.endsWith("/project")).toBe(true);
  });

  it("rejects paths outside allowed roots", async () => {
    await expect(assertSafeWorkspacePath("/tmp/not-inside-vibe-codex", ctx.config)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });

  it("rejects traversal outside the workspace", async () => {
    const workspace = path.join(ctx.root, "project");
    await fs.mkdir(workspace);
    await expect(assertSafeFilePath(workspace, "../escape.txt", ctx.config)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });

  it("blocks sensitive paths", () => {
    expect(isSensitivePath(`${process.env.HOME}/.ssh/id_rsa`)).toBe(true);
    expect(isSensitivePath(`${process.env.HOME}/.codex/auth.json`)).toBe(true);
    expect(isSensitivePath(`${process.env.HOME}/Library/Keychains/login.keychain-db`)).toBe(true);
  });

  it("resolves nested nonexistent parents through the nearest existing ancestor", async () => {
    const workspace = path.join(ctx.root, "project");
    const outside = path.join(ctx.root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace, "escape"));
    await expect(assertSafeFilePath(workspace, "escape/not/yet/existing/file.txt", ctx.config)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });

  it("blocks sensitive lexical names even when symlinked to an ordinary file", async () => {
    const workspace = path.join(ctx.root, "project");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "ordinary.txt"), "public");
    await fs.symlink("ordinary.txt", path.join(workspace, ".env"));
    await expect(assertSafeFilePath(workspace, ".env", ctx.config)).rejects.toMatchObject({ code: "SENSITIVE_PATH_BLOCKED" });
  });

  it("handles symlink escapes when practical", async () => {
    const workspace = path.join(ctx.root, "project");
    await fs.mkdir(workspace);
    const outside = await fs.mkdtemp(path.join(ctx.root, "..", "outside-"));
    await fs.symlink(outside, path.join(workspace, "link"));
    await expect(assertSafeFilePath(workspace, "link/file.txt", ctx.config)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });
});
