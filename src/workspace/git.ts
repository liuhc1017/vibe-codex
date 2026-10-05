import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Config } from "../config/types.js";
import { assertSafeWorkspacePath, assertSafeNonSymlinkFilePath } from "../safety/paths.js";
import { decodeBoundedUtf8, ProcessResult, runProcessArgv } from "../util/spawn.js";
import { VibeError } from "../util/errors.js";
import { classifyCommand } from "../safety/commandRisk.js";

export interface GitStatusEntry {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string;
}

/** Porcelain v1 -z: XY <destination> NUL [<original> NUL for a rename/copy]. */
export function parseGitStatus(text: string): GitStatusEntry[] {
  if (!text) return [];
  if (!text.endsWith("\0")) throw new Error("Incomplete Git NUL status output.");
  const records = text.split("\0");
  records.pop();
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!/^[ MADRCUT?!]{2} /.test(record) || record.length < 4) throw new Error("Malformed Git status record.");
    const entry: GitStatusEntry = { indexStatus: record[0], worktreeStatus: record[1], path: record.slice(3) };
    if (/[RC]/.test(record.slice(0, 2))) {
      if (!records[i + 1]) throw new Error("Missing Git rename source.");
      entry.originalPath = records[++i];
    }
    entries.push(entry);
  }
  return entries;
}

function displayPath(file: string): string {
  return /[\s"\\]| -> /.test(file) ? JSON.stringify(file) : file;
}
function renderStatus(entries: GitStatusEntry[]): string {
  return entries.map((entry) => `${entry.indexStatus}${entry.worktreeStatus} ${entry.originalPath ? `${displayPath(entry.originalPath)} -> ` : ""}${displayPath(entry.path)}\n`).join("");
}

/** For old human-readable baseline snapshots, without trimming away the XY columns. */
export function parseGitShortStatus(text: string): GitStatusEntry[] {
  const decode = (value: string): string => {
    if (!value.startsWith('"')) return value;
    try { return JSON.parse(value) as string; } catch { return value; }
  };
  return text.split("\n").filter((line) => /^[ MADRCUT?!]{2} /.test(line)).map((line) => {
    let value = line.slice(3);
    let originalPath: string | undefined;
    if (/[RC]/.test(line.slice(0, 2))) {
      let quoted = false;
      for (let i = 0; i < value.length; i++) {
        if (value[i] === "\\" && quoted) { i++; continue; }
        if (value[i] === '"') quoted = !quoted;
        if (!quoted && value.slice(i, i + 4) === " -> ") {
          originalPath = decode(value.slice(0, i));
          value = value.slice(i + 4);
          break;
        }
      }
    }
    return { indexStatus: line[0], worktreeStatus: line[1], path: decode(value), ...(originalPath ? { originalPath } : {}) };
  });
}

const gitEnv: Record<string, string | undefined> = {
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_EXTERNAL_DIFF: undefined,
  GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_NAMESPACE: undefined,
  GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
};
function runGit(cwd: string, config: Config, args: string[], maxBytes = config.maxCommandOutputBytes): Promise<ProcessResult> {
  return runProcessArgv({ file: "git", args: ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "status.relativePaths=true", ...args], cwd, env: gitEnv, timeoutMs: config.commandTimeoutMs, maxOutputBytes: maxBytes });
}

function artifact(file: string): boolean { return file === ".vibe-codex" || file.startsWith(".vibe-codex/"); }

async function safeStatus(cwd: string, config: Config) {
  const result = await runGit(cwd, config, ["status", "--porcelain=v1", "-z", "--renames", "--untracked-files=all", "--", "."], 2_000_000);
  if (result.exitCode !== 0 || result.timedOut) throw new VibeError("COMMAND_BLOCKED", "Unable to collect Git status safely.", { stderr: result.stderr, timedOut: result.timedOut });
  let statusText = result.stdout;
  if (result.stdoutTruncated) {
    // A truncated rename may lose its second record. Drop the last full record too.
    const last = statusText.lastIndexOf("\0");
    statusText = last < 0 ? "" : statusText.slice(0, last + 1);
    while (statusText) {
      try { parseGitStatus(statusText); break; } catch { statusText = statusText.slice(0, statusText.lastIndexOf("\0", statusText.length - 2) + 1); }
    }
  }
  const entries = parseGitStatus(statusText);
  // Porcelain -z always uses repository-root paths, even when status.relativePaths=true.
  const prefixResult = await runGit(cwd, config, ["rev-parse", "--show-prefix"], 16_000);
  if (prefixResult.exitCode !== 0 || prefixResult.timedOut || prefixResult.stdoutTruncated) throw new VibeError("COMMAND_BLOCKED", "Unable to establish the Git workspace prefix safely.");
  const prefix = prefixResult.stdout.replace(/\n$/, "");
  // Index symlinks/gitlinks can be deleted/replaced locally and must still not be diffed.
  const index = await runGit(cwd, config, ["ls-files", "--stage", "-z", "--", "."], 4_000_000);
  if (index.exitCode !== 0 || index.timedOut || index.stdoutTruncated) throw new VibeError("COMMAND_BLOCKED", "Unable to validate Git index paths safely.");
  const unsafeIndexPaths = new Set(index.stdout.split("\0").flatMap((record) => /^(120000|160000) /.test(record) ? [record.slice(record.indexOf("\t") + 1)] : []));
  const safe: GitStatusEntry[] = [];
  const omitted: string[] = [];
  for (const entry of entries) {
    try {
      if (prefix) {
        if (!entry.path.startsWith(prefix)) throw new Error("Status path is outside the workspace.");
        entry.path = entry.path.slice(prefix.length);
        if (entry.originalPath) {
          if (!entry.originalPath.startsWith(prefix)) throw new Error("Rename source is outside the workspace.");
          entry.originalPath = entry.originalPath.slice(prefix.length);
        }
      }
      const paths = [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])];
      for (const file of paths) {
        if (artifact(file) || unsafeIndexPaths.has(file)) throw new Error("Run artifact, symlink or submodule.");
        await assertSafeNonSymlinkFilePath(cwd, file, config);
      }
      safe.push(entry);
    } catch { omitted.push(entry.path); }
  }
  return { result, entries: safe, omitted, truncated: !!result.stdoutTruncated };
}

export async function gitInit(workspacePath: string, config: Config) {
  return runGit(await assertSafeWorkspacePath(workspacePath, config), config, ["init"]);
}

export async function gitStatus(workspacePath: string, config: Config) {
  const status = await safeStatus(await assertSafeWorkspacePath(workspacePath, config), config);
  return { ...status.result, stdout: renderStatus(status.entries), stdoutTruncated: status.truncated };
}

export interface WorkspaceChanges {
  gitStatus: string;
  gitDiffSummary: string;
  changedFiles: string[];
  omittedFiles: string[];
  truncated: boolean;
}

async function collectChanges(workspacePath: string, config: Config, maxBytes?: number, options?: { flags?: string[]; paths?: string[]; includeUntracked?: boolean }) {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  if (options?.flags) {
    const expectedArgv = ["git", "diff", ...options.flags];
    const validated = classifyCommand(expectedArgv.join(" "));
    if (options.flags.includes("--") || validated.risk !== "safe" || !validated.argv || validated.argv.length !== expectedArgv.length || validated.argv.some((word, index) => word !== expectedArgv[index])) throw new VibeError("COMMAND_BLOCKED", "Unsupported Git diff flags.");
  }
  for (const operand of options?.paths ?? []) {
    if (operand.split(path.sep).includes("..")) throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Parent traversal is not an allowed Git diff operand.");
    await assertSafeNonSymlinkFilePath(cwd, path.isAbsolute(operand) ? path.relative(cwd, operand) : operand, config);
  }
  const status = await safeStatus(cwd, config);
  const requestedLimit = maxBytes ?? config.maxCommandOutputBytes;
  const limit = Number.isFinite(requestedLimit) ? Math.min(4_000_000, Math.max(0, Math.floor(requestedLimit))) : config.maxCommandOutputBytes;
  const selected = (file: string) => !options?.paths?.length || options.paths.some((operand) => {
    const relative = path.relative(cwd, path.resolve(cwd, operand)).split(path.sep).join("/");
    return !relative || file === relative || file.startsWith(`${relative}/`);
  });
  const entries = status.entries.filter((entry) => selected(entry.path) || (!!entry.originalPath && selected(entry.originalPath)));
  const omitted = new Set(status.omitted);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = status.truncated;
  let diffExitCode = 0;
  let diffTimedOut = false;
  const errors: string[] = [];
  let errorBytes = 0;
  const append = (text: string, wasTruncated = false) => {
    const buffer = Buffer.from(text);
    const remaining = Math.max(0, limit - bytes);
    const kept = buffer.subarray(0, remaining);
    if (kept.length) chunks.push(kept);
    bytes += kept.length;
    if (buffer.length > remaining || wasTruncated) truncated = true;
  };
  const tracked = entries.filter((entry) => entry.indexStatus !== "?");
  const paths = [...new Set(tracked.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]))];
  const flags = options?.flags ?? [];
  const modes = flags.includes("--cached") || flags.includes("--staged") ? ["staged"] : options ? ["unstaged"] : ["staged", "unstaged"];
  for (const mode of modes) {
    for (let i = 0; i < paths.length; i += 100) {
      if (bytes >= limit) { truncated = true; break; }
      const batch = paths.slice(i, i + 100);
      // Revalidate immediately before Git reads working-tree paths.
      const safeBatch: string[] = [];
      for (const file of batch) {
        try { await assertSafeNonSymlinkFilePath(cwd, file, config); safeBatch.push(file); } catch { omitted.add(file); }
      }
      if (!safeBatch.length) continue;
      const result = await runGit(cwd, config, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--relative", "--no-color", ...(mode === "staged" ? ["--cached"] : []), ...flags.filter((flag) => flag !== "--cached" && flag !== "--staged"), "--", ...safeBatch], limit - bytes);
      if (result.stderr && errorBytes < config.maxCommandOutputBytes) {
        const kept = decodeBoundedUtf8(Buffer.from(result.stderr).subarray(0, config.maxCommandOutputBytes - errorBytes));
        errors.push(kept); errorBytes += Buffer.byteLength(kept) + 1;
      }
      if (result.exitCode !== 0) diffExitCode = result.exitCode ?? 1;
      diffTimedOut ||= result.timedOut;
      if (result.timedOut || (result.exitCode !== 0 && !(flags.includes("--check") && (result.exitCode === 1 || result.exitCode === 2)))) { truncated = true; for (const file of safeBatch) omitted.add(file); continue; }
      append(result.stdout, result.stdoutTruncated);
    }
  }
  if (!options || options.includeUntracked) for (const entry of entries.filter((item) => item.indexStatus === "?")) {
    const file = entry.path;
    if (bytes >= limit) { truncated = true; omitted.add(file); continue; }
    try {
      const target = await assertSafeNonSymlinkFilePath(cwd, file, config);
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await assertSafeNonSymlinkFilePath(cwd, file, config);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit - bytes) { omitted.add(file); truncated = true; continue; }
        const buffer = Buffer.alloc(Math.min(stat.size, limit - bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, bytesRead);
        if (content.includes(0)) { omitted.add(file); continue; }
        const lines = content.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        const a = displayPath(`a/${file}`), b = displayPath(`b/${file}`);
        append(`diff --git ${a} ${b}\nnew file mode ${stat.mode & 0o111 ? "100755" : "100644"}\n--- /dev/null\n+++ ${b}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}${content.length && content.at(-1) !== 10 ? "\\ No newline at end of file\n" : ""}`);
      } finally { await handle.close(); }
    } catch { omitted.add(file); }
  }
  const changes: WorkspaceChanges = { gitStatus: renderStatus(entries), gitDiffSummary: decodeBoundedUtf8(Buffer.concat(chunks), limit), changedFiles: entries.map((entry) => entry.path), omittedFiles: [...omitted], truncated };
  return { changes, statusResult: { ...status.result, exitCode: diffTimedOut ? null : diffExitCode, timedOut: diffTimedOut, stderr: decodeBoundedUtf8(Buffer.from(errors.join("\n")), config.maxCommandOutputBytes) } };
}

/** Bounded safe staged + unstaged + untracked changes for task results. */
export async function collectWorkspaceChanges(workspacePath: string, config: Config, maxBytes?: number): Promise<WorkspaceChanges> {
  return (await collectChanges(workspacePath, config, maxBytes)).changes;
}

/** Legacy ProcessResult interface; now safely includes all change kinds by default. */
export async function gitDiff(workspacePath: string, config: Config, maxBytes?: number, options?: { flags?: string[]; paths?: string[] }) {
  const { changes, statusResult } = await collectChanges(workspacePath, config, maxBytes, options);
  return { ...statusResult, stdout: changes.gitDiffSummary, stdoutTruncated: changes.truncated };
}

export async function gitIsRepository(workspacePath: string, config: Config): Promise<boolean> {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  const result = await runGit(cwd, config, ["rev-parse", "--is-inside-work-tree"], 20_000);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}
