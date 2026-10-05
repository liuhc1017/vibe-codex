import { Config } from "../config/types.js";
import { collectWorkspaceChanges } from "../workspace/git.js";
import { VibeError } from "../util/errors.js";
import { RunStore } from "./runStore.js";

export async function collectRunResult(config: Config, store: RunStore, runId: string, maxBytes = 80_000) {
  const run = store.getRun(runId);
  if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId });
  const changes = await collectWorkspaceChanges(run.workspacePath, config, maxBytes);
  // Git collection yields to live turn events; merge into the latest metadata.
  const current = store.getRun(runId);
  if (!current) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId });
  const updated = store.updateRun(runId, {
    metadata: { ...current.metadata, finalGitStatus: changes.gitStatus, changedFilesSinceRun: changes.changedFiles },
  });
  return {
    run: updated,
    runId,
    projectId: updated.metadata?.projectId,
    threadId: updated.metadata?.codexThreadId,
    turnId: updated.metadata?.codexTurnId,
    status: updated.status,
    finalAnswer: typeof updated.metadata?.finalAnswer === "string" ? updated.metadata.finalAnswer : updated.status === "completed" ? updated.summary ?? updated.stdout : undefined,
    output: updated.stdout,
    error: updated.stderr || undefined,
    ...changes,
    changedFilesSinceRun: changes.changedFiles,
    changesAttribution: "These are current repository changes, including pre-existing work. They do not establish task completion or exclusive authorship.",
  };
}
