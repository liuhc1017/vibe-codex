import { describe, expect, it, vi } from "vitest";
import { collectDiagnostics } from "../src/server/diagnostics.js";
import { detectManagedCodexAppServer } from "../src/codex/codexAppServerManager.js";
import { tempConfig } from "./helpers.js";

vi.mock("../src/codex/codexCli.js", () => ({ getCodexVersion: vi.fn(async () => "codex-cli test") }));
vi.mock("../src/util/spawn.js", () => ({ runProcessArgv: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })) }));
vi.mock("../src/codex/codexAppServerManager.js", () => ({ detectManagedCodexAppServer: vi.fn() }));

describe("read-only execution diagnostics", () => {
  it.each(["disabled", "manual", "auto"] as const)("does not claim execution ready with an unavailable %s runner and autostart disabled", async (mode) => {
    const ctx = await tempConfig();
    try {
      ctx.config.codexAppServerMode = mode;
      ctx.config.codexAppServerAutostart = false;
      vi.mocked(detectManagedCodexAppServer).mockResolvedValueOnce({ available: false, transport: "ws", startedByVibeCodex: false, mode });
      const result = await collectDiagnostics(ctx.config);
      expect(result.codex.loggedIn).toBe(true);
      expect(result.codex.executionReady).toBe(false);
      expect(result.checks.find((check) => check.name === "Local task runner")?.ok).toBe(false);
    } finally { await ctx.cleanup(); }
  });

  it("explains automatic first-task startup without starting a server or claiming a tested model turn", async () => {
    const ctx = await tempConfig();
    try {
      ctx.config.codexAppServerMode = "auto";
      vi.mocked(detectManagedCodexAppServer).mockResolvedValueOnce({ available: false, transport: "ws", startedByVibeCodex: false, mode: "auto" });
      const result = await collectDiagnostics(ctx.config);
      expect(result.codex.executionReady).toBe(true);
      expect(result.codex.appServer.available).toBe(false);
      expect(result.checks.find((check) => check.name === "Local task runner")?.detail).toContain("first task");
      expect(result.codex.note).toContain("not proof");
    } finally { await ctx.cleanup(); }
  });
});
