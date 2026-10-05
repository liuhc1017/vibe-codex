import { AutonomyLevel, Config } from "../config/types.js";
import { RunStore } from "../runs/runStore.js";
import { ProjectRecord } from "../runs/types.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { VibeError } from "../util/errors.js";
import { compileProjectCodexPrompt } from "./projectPrompt.js";
import { getRunCoordinator } from "./runCoordinator.js";

export function resolveProject(store: RunStore, ref: string): ProjectRecord {
  const project = store.getProject(ref) ?? store.getProjectByName(ref) ?? store.getProjectByPath(ref);
  if (!project) throw new VibeError("CONFIG_ERROR", "Register this project in the local control page first.", { projectRef: ref });
  return project;
}

export async function startProjectTask(config: Config, store: RunStore, args: {
  projectRef: string;
  userGoal: string;
  autonomy?: AutonomyLevel;
  codexThreadId?: string;
  forkThread?: boolean;
  setDefaultThread?: boolean;
  context?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  verification?: string[];
}) {
  const project = resolveProject(store, args.projectRef);
  const workspacePath = await assertSafeWorkspacePath(project.path, config);
  const autonomy = args.autonomy ?? "workspace";
  const threadId = args.codexThreadId ?? project.defaultCodexThreadId;
  const parent = threadId ? store.listRuns(workspacePath).find((run) => run.metadata?.codexThreadId === threadId) : undefined;
  return getRunCoordinator(config, store).start({
    workspacePath,
    autonomy,
    projectId: project.id,
    threadId,
    fork: args.forkThread,
    parentRunId: parent?.id,
    setDefaultThread: args.setDefaultThread ?? true,
    prompt: (runId) => compileProjectCodexPrompt({
      project, runId, workspacePath, userGoal: args.userGoal, executionMode: "codex-app-thread", autonomy,
      codexThreadId: threadId, context: args.context, constraints: args.constraints,
      acceptanceCriteria: args.acceptanceCriteria, verification: args.verification,
    }),
  });
}

export async function continueProjectTask(config: Config, store: RunStore, args: {
  projectRef: string;
  instruction: string;
  autonomy?: AutonomyLevel;
  codexThreadId?: string;
  setDefaultThread?: boolean;
}) {
  const project = resolveProject(store, args.projectRef);
  const threadId = args.codexThreadId ?? project.defaultCodexThreadId;
  if (!threadId) throw new VibeError("CONFIG_ERROR", "This project has no conversation yet. Start a task first.", { projectId: project.id });
  return startProjectTask(config, store, { ...args, userGoal: args.instruction, codexThreadId: threadId });
}
