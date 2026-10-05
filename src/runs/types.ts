import { AutonomyLevel } from "../config/types.js";

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "recovering" | "recovery_required" | "interrupted" | "running_visible" | "app_visible_ready" | "interactive_ready" | "interactive_started" | "unknown_interactive" | "unknown_app_visible" | "completed" | "completed_visible" | "failed" | "failed_visible" | "approval_required";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  repoRemote?: string;
  preferredExecutionMode?: "codex-app-thread" | "codex-app-visible" | "ghostty-visible";
  defaultCodexThreadId?: string;
  recentCodexThreadIds?: string[];
  lastUsedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  autonomy: AutonomyLevel;
  prompt: string;
  codexCommand: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  summary?: string;
  metadata?: Record<string, unknown>;
}
