import { describe, expect, it, vi } from "vitest";
import { collectRunResult } from "../src/runs/results.js";
import { initRunStore } from "../src/runs/runStore.js";
import { collectWorkspaceChanges, WorkspaceChanges } from "../src/workspace/git.js";
import { tempConfig } from "./helpers.js";

vi.mock("../src/workspace/git.js", () => ({ collectWorkspaceChanges: vi.fn() }));

const changes: WorkspaceChanges = { gitStatus: " M hello.txt", gitDiffSummary: "safe diff", changedFiles: ["hello.txt"], omittedFiles: [], truncated: false };

describe("managed task result collection", () => {
  it("preserves a turn acknowledgment and completion arriving while Git is collected", async () => {
    const ctx = await tempConfig();
    const store = initRunStore(ctx.config.databasePath);
    let resolveChanges!: (value: WorkspaceChanges) => void;
    vi.mocked(collectWorkspaceChanges).mockImplementationOnce(() => new Promise((resolve) => { resolveChanges = resolve; }));
    try {
      const run = store.createRun({ workspacePath: ctx.root, status: "running", autonomy: "workspace", prompt: "Task", command: "codex-app-thread", metadata: { codexThreadId: "thread-1" } });
      const pending = collectRunResult(ctx.config, store, run.id);
      store.updateRun(run.id, { status: "completed", stdout: "Real final answer", summary: "Real final answer", metadata: { codexThreadId: "thread-1", codexTurnId: "turn-1", codexTurnStatus: "completed", finalAnswer: "Real final answer", completedAt: "2026-10-04T00:00:00Z" } });
      resolveChanges(changes);
      const result = await pending;
      expect(result.status).toBe("completed");
      expect(result.turnId).toBe("turn-1");
      expect(result.finalAnswer).toBe("Real final answer");
      expect(store.getRun(run.id)?.metadata).toMatchObject({ codexTurnId: "turn-1", codexTurnStatus: "completed", finalAnswer: "Real final answer", completedAt: "2026-10-04T00:00:00Z", finalGitStatus: changes.gitStatus });
      expect(result.changesAttribution).toContain("pre-existing work");
    } finally { store.db.close(); await ctx.cleanup(); }
  });

  it("does not turn a failure summary or dirty workspace into a final answer or completion", async () => {
    const ctx = await tempConfig();
    const store = initRunStore(ctx.config.databasePath);
    vi.mocked(collectWorkspaceChanges).mockResolvedValueOnce(changes);
    try {
      const run = store.createRun({ workspacePath: ctx.root, status: "failed", autonomy: "workspace", prompt: "Task", command: "codex-app-thread", stderr: "Model failed", metadata: { summary: "Codex turn failed." } });
      const result = await collectRunResult(ctx.config, store, run.id);
      expect(result.status).toBe("failed");
      expect(result.finalAnswer).toBeUndefined();
      expect(result.error).toBe("Model failed");
      expect(result.changedFiles).toEqual(["hello.txt"]);
    } finally { store.db.close(); await ctx.cleanup(); }
  });
});
