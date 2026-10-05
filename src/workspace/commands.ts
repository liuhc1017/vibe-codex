import path from "node:path";
import { AutonomyLevel, Config } from "../config/types.js";
import { canExecuteRisk } from "../safety/approvals.js";
import { classifyCommand } from "../safety/commandRisk.js";
import { assertSafeWorkspacePath, assertSafeNonSymlinkFilePath } from "../safety/paths.js";
import { VibeError } from "../util/errors.js";
import { runProcessArgv } from "../util/spawn.js";
import { gitDiff } from "./git.js";

export async function runWorkspaceCommand(args: {
  workspacePath: string;
  command: string;
  autonomy: AutonomyLevel;
  timeoutMs?: number;
  config: Config;
}) {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const risk = classifyCommand(args.command);
  if (risk.risk === "blocked") throw new VibeError("COMMAND_BLOCKED", risk.reason, { command: args.command });
  if (risk.risk === "dangerous" || !risk.argv) {
    return { command: args.command, risk: risk.risk, executed: false, approvalRequired: true, reason: risk.reason };
  }
  for (const operand of risk.pathOperands ?? []) {
    // Do not normalize away a symlink/.. traversal before the executable sees it.
    if (operand.split(/[\\/]/).includes("..")) throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Parent traversal is not an allowed command operand.", { operand });
    // Absolute paths are accepted only when they resolve to a non-symlink workspace path.
    const relative = path.isAbsolute(operand) ? path.relative(cwd, operand) : operand;
    await assertSafeNonSymlinkFilePath(cwd, relative, args.config);
  }
  if (!canExecuteRisk(args.autonomy, risk.risk)) {
    return { command: args.command, risk: risk.risk, executed: false, approvalRequired: args.autonomy !== "manual", reason: `Autonomy ${args.autonomy} cannot execute ${risk.risk} commands.` };
  }
  const timeoutMs = Math.max(1, Math.min(args.timeoutMs ?? args.config.commandTimeoutMs, args.config.commandTimeoutMs));
  const commandConfig = { ...args.config, commandTimeoutMs: timeoutMs };
  let argv = risk.argv.slice(1);
  const file = risk.argv[0];
  const isGit = file === "git";
  // Content-producing Git diff must enumerate and validate files, not read a directory-wide pathspec.
  const result = isGit && argv[0] === "diff"
    ? await gitDiff(cwd, commandConfig, args.config.maxCommandOutputBytes, { flags: argv.slice(1, argv.includes("--") ? argv.indexOf("--") : argv.length), paths: risk.pathOperands })
    : await (() => {
      if (isGit) {
        if (!argv.includes("--")) argv.push("--", ".");
        if (argv[0] === "log" && !argv.some((word) => /^(-n|--max-count=)/.test(word))) argv.splice(1, 0, "--max-count=50");
        argv = ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "status.relativePaths=true", ...argv];
      }
      return runProcessArgv({ file, args: argv, cwd, timeoutMs, maxOutputBytes: args.config.maxCommandOutputBytes,
        ...(isGit ? { env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_EXTERNAL_DIFF: undefined, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } } : {}),
      });
    })();
  return { command: args.command, risk: risk.risk, executed: true, approvalRequired: false, reason: risk.reason, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, truncated: result.stdoutTruncated || result.stderrTruncated };
}
