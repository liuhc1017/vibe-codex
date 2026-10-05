import fs from "node:fs/promises";
import path from "node:path";
import { constants, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Config, AutonomyLevel } from "../config/types.js";
import { collectWorkspaceChanges, gitDiff, gitStatus, parseGitShortStatus } from "../workspace/git.js";
import { RunStore } from "../runs/runStore.js";
import { RunRecord } from "../runs/types.js";
import { assertSafeWorkspacePath, assertSafeNonSymlinkFilePath } from "../safety/paths.js";
import { decodeBoundedUtf8, runProcessArgv } from "../util/spawn.js";
import { compileCodexPrompt } from "./promptCompiler.js";
import { logger } from "../util/logger.js";
import { VibeError } from "../util/errors.js";

export type ExecutionMode = "exec-hidden" | "terminal-visible" | "ghostty-visible" | "codex-app-visible" | "app-supervised" | "codex-app-thread";

export interface CodexExecCapabilities {
  supportsSandbox: boolean;
  supportsExecAskForApproval: boolean;
  supportsGlobalAskForApproval: boolean;
}

const SANDBOX_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const;
const APPROVAL_VALUES = ["untrusted", "on-failure", "on-request", "never"] as const;
const artifactWriteFlag = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

function normalizeSandbox(value: string | undefined): string {
  if (value && (SANDBOX_VALUES as readonly string[]).includes(value)) return value;
  if (value) logger.warn("unsupported_codex_sandbox_fallback", { configured: value, fallback: "workspace-write" });
  return "workspace-write";
}

function normalizeApproval(value: string | undefined): string {
  if (value && (APPROVAL_VALUES as readonly string[]).includes(value)) return value;
  if (value) logger.warn("unsupported_codex_approval_fallback", { configured: value, fallback: "untrusted" });
  return "untrusted";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function inspectCodexExecCapabilities(config: Config): Promise<CodexExecCapabilities> {
  const [execHelp, globalHelp] = await Promise.all([
    runProcessArgv({ file: config.codexBin, args: ["exec", "--help"], timeoutMs: 10_000, maxOutputBytes: 50_000 }),
    runProcessArgv({ file: config.codexBin, args: ["--help"], timeoutMs: 10_000, maxOutputBytes: 50_000 }),
  ]);
  const execText = `${execHelp.stdout}\n${execHelp.stderr}`;
  const globalText = `${globalHelp.stdout}\n${globalHelp.stderr}`;
  return {
    supportsSandbox: execText.includes("--sandbox") || globalText.includes("--sandbox"),
    supportsExecAskForApproval: execText.includes("--ask-for-approval"),
    supportsGlobalAskForApproval: globalText.includes("--ask-for-approval"),
  };
}

export function buildCodexExecArgv(args: {
  prompt: string;
  sandbox?: string;
  approval?: string;
  capabilities: CodexExecCapabilities;
}): string[] {
  const sandbox = normalizeSandbox(args.sandbox);
  const approval = normalizeApproval(args.approval);
  const argv: string[] = [];
  if (args.capabilities.supportsGlobalAskForApproval && !args.capabilities.supportsExecAskForApproval) {
    argv.push("--ask-for-approval", approval);
  }
  argv.push("exec");
  if (args.capabilities.supportsSandbox) argv.push("--sandbox", sandbox);
  if (args.capabilities.supportsExecAskForApproval) argv.push("--ask-for-approval", approval);
  if (!args.capabilities.supportsGlobalAskForApproval && !args.capabilities.supportsExecAskForApproval) {
    logger.warn("codex_approval_flag_unsupported", { fallback: "omitting ask-for-approval flag" });
  }
  argv.push(args.prompt);
  return argv;
}

function codexArgs(prompt: string, config: Config, capabilities: CodexExecCapabilities): string[] {
  const args = buildCodexExecArgv({
    prompt,
    sandbox: config.defaultCodexSandbox,
    approval: config.defaultCodexApproval,
    capabilities,
  });
  if (args.includes("--approval")) {
    throw new VibeError("CODEX_EXEC_FAILED", "Internal error: deprecated --approval flag must not be used.");
  }
  return args;
}

function codexScriptCommand(config: Config, capabilities: CodexExecCapabilities, promptPath: string): string {
  const sandbox = normalizeSandbox(config.defaultCodexSandbox);
  const approval = normalizeApproval(config.defaultCodexApproval);
  const parts: string[] = [shellQuote(config.codexBin)];
  if (capabilities.supportsGlobalAskForApproval && !capabilities.supportsExecAskForApproval) {
    parts.push("--ask-for-approval", shellQuote(approval));
  }
  parts.push("exec");
  if (capabilities.supportsSandbox) parts.push("--sandbox", shellQuote(sandbox));
  if (capabilities.supportsExecAskForApproval) parts.push("--ask-for-approval", shellQuote(approval));
  parts.push(`"$(cat ${shellQuote(promptPath)})"`);
  return parts.join(" ");
}

function redactedCodexScriptCommand(config: Config, capabilities: CodexExecCapabilities): string {
  const sandbox = normalizeSandbox(config.defaultCodexSandbox);
  const approval = normalizeApproval(config.defaultCodexApproval);
  const parts: string[] = [config.codexBin];
  if (capabilities.supportsGlobalAskForApproval && !capabilities.supportsExecAskForApproval) {
    parts.push("--ask-for-approval", approval);
  }
  parts.push("exec");
  if (capabilities.supportsSandbox) parts.push("--sandbox", sandbox);
  if (capabilities.supportsExecAskForApproval) parts.push("--ask-for-approval", approval);
  parts.push("<prompt from prompt.md>");
  return parts.join(" ");
}

async function ensureRunDir(workspacePath: string, runId: string, config: Config) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new VibeError("CONFIG_ERROR", "Invalid run artifact ID.");
  const runDir = await assertSafeNonSymlinkFilePath(workspacePath, path.join(".vibe-codex", "runs", runId), config);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

async function writePrompt(runDir: string, prompt: string) {
  const promptPath = path.join(runDir, "prompt.md");
  await fs.writeFile(promptPath, prompt, { encoding: "utf8", flag: artifactWriteFlag, mode: 0o600 });
  return promptPath;
}

async function writeRootPromptHandoff(workspacePath: string, runId: string, promptPath: string, prompt: string, config: Config) {
  const rootPromptPath = await assertSafeNonSymlinkFilePath(workspacePath, "VIBE_CODEX_PROMPT.md", config);
  const relativePromptPath = path.relative(workspacePath, promptPath);
  await fs.writeFile(rootPromptPath, [
    "# Vibe Codex Prompt",
    "",
    `Run ID: ${runId}`,
    `Canonical prompt: ${relativePromptPath}`,
    "",
    "Paste/send the prompt below in Codex Desktop.",
    "",
    "---",
    "",
    prompt,
  ].join("\n"), { encoding: "utf8", flag: artifactWriteFlag, mode: 0o600 });
  return rootPromptPath;
}

async function writeBaselineMetadata(args: {
  runDir: string;
  runId: string;
  workspacePath: string;
  promptPath: string;
  rootPromptPath?: string;
  baselineStatus?: string;
  executionMode: ExecutionMode;
  terminalApp?: string;
  logPath?: string;
  scriptPath?: string;
}) {
  const baselineStatusPath = path.join(args.runDir, "baseline-status.txt");
  const finalStatusPath = path.join(args.runDir, "final-status.txt");
  const metadataPath = path.join(args.runDir, "metadata.json");
  await fs.writeFile(baselineStatusPath, args.baselineStatus ?? "", { encoding: "utf8", flag: artifactWriteFlag, mode: 0o600 });
  await fs.writeFile(metadataPath, JSON.stringify({
    runId: args.runId,
    workspacePath: args.workspacePath,
    promptPath: args.promptPath,
    rootPromptPath: args.rootPromptPath,
    logPath: args.logPath,
    scriptPath: args.scriptPath,
    baselineStatusPath,
    finalStatusPath,
    executionMode: args.executionMode,
    terminalApp: args.terminalApp,
    createdAt: new Date().toISOString(),
  }, null, 2), { encoding: "utf8", flag: artifactWriteFlag, mode: 0o600 });
  return { baselineStatusPath, finalStatusPath, metadataPath };
}

async function copyPromptToClipboard(args: {
  promptPath: string;
  cwd: string;
  config: Config;
  copy?: boolean;
  verify?: boolean;
  delayBeforeMs?: number;
}) {
  if (args.copy === false) return { copied: false, stdout: "", stderr: "", exitCode: null, verified: false };
  if (args.delayBeforeMs && args.delayBeforeMs > 0) await delay(args.delayBeforeMs);
  const content = await fs.readFile(args.promptPath);
  const expected = content.toString("utf8");
  const copyOnce = () => runProcessArgv({
    file: "pbcopy",
    stdin: content,
    cwd: args.cwd,
    timeoutMs: 10_000,
    maxOutputBytes: args.config.maxCommandOutputBytes,
  }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  }));
  const verifyOnce = () => runProcessArgv({
    file: "pbpaste",
    cwd: args.cwd,
    timeoutMs: 10_000,
    maxOutputBytes: args.config.maxCommandOutputBytes,
  }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  }));
  const firstCopy = await copyOnce();
  if (!args.verify) {
    return { copied: firstCopy.exitCode === 0, stdout: firstCopy.stdout, stderr: firstCopy.stderr, exitCode: firstCopy.exitCode, verified: false };
  }
  let verifyResult = await verifyOnce();
  let verified = verifyResult.exitCode === 0 && verifyResult.stdout === expected;
  let retryCopy: Awaited<ReturnType<typeof copyOnce>> | undefined;
  if (firstCopy.exitCode === 0 && !verified) {
    await delay(250);
    retryCopy = await copyOnce();
    verifyResult = await verifyOnce();
    verified = verifyResult.exitCode === 0 && verifyResult.stdout === expected;
  }
  const stderr = [firstCopy.stderr, retryCopy?.stderr, verifyResult.stderr].filter(Boolean).join("\n");
  const stdout = [firstCopy.stdout, retryCopy?.stdout].filter(Boolean).join("\n");
  return {
    copied: firstCopy.exitCode === 0 && (!retryCopy || retryCopy.exitCode === 0) && verified,
    stdout,
    stderr,
    exitCode: retryCopy?.exitCode ?? firstCopy.exitCode,
    verified,
  };
}

export async function createTerminalVisibleRunArtifacts(args: {
  workspacePath: string;
  runId: string;
  prompt: string;
  config: Config;
  capabilities: CodexExecCapabilities;
  executionMode?: "terminal-visible" | "ghostty-visible";
  terminalApp?: string;
  baselineStatus?: string;
}) {
  const runDir = await ensureRunDir(args.workspacePath, args.runId, args.config);
  const promptPath = await writePrompt(runDir, args.prompt);
  const logPath = path.join(runDir, "codex.log");
  const scriptPath = path.join(runDir, "run-codex.sh");
  const { baselineStatusPath, finalStatusPath, metadataPath } = await writeBaselineMetadata({
    runDir,
    runId: args.runId,
    workspacePath: args.workspacePath,
    promptPath,
    logPath,
    scriptPath,
    baselineStatus: args.baselineStatus,
    executionMode: args.executionMode ?? "terminal-visible",
    terminalApp: args.terminalApp ?? "Terminal",
  });
  const codexCommand = codexScriptCommand(args.config, args.capabilities, promptPath);
  const redactedCodexCommand = redactedCodexScriptCommand(args.config, args.capabilities);
  const promptRelativePath = path.relative(args.workspacePath, promptPath);
  const script = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(args.workspacePath)}
printf '%s\\n' ${shellQuote(`Vibe Codex visible run: ${args.runId}`)}
printf '%s\\n' ${shellQuote(`Workspace: ${args.workspacePath}`)}
printf '%s\\n' ${shellQuote(`Prompt: ${promptRelativePath}`)}
printf '%s\\n' ${shellQuote(`Prompt path: ${promptPath}`)}
printf '%s\\n' ${shellQuote(`Log path: ${logPath}`)}
printf '%s\\n' ${shellQuote(`Execution mode: ${args.executionMode ?? "terminal-visible"}`)}
printf '%s\\n' ${shellQuote(`Terminal app: ${args.terminalApp ?? "Terminal"}`)}
printf '%s\\n' ${shellQuote(`Codex command: ${redactedCodexCommand}`)}
printf '%s\\n' ''
printf '%s\\n' 'Prompt follows:'
printf '%s\\n' '----------------------------------------'
cat ${shellQuote(promptPath)}
printf '%s\\n' ''
printf '%s\\n' '----------------------------------------'
printf '%s\\n' 'Press Enter to start Codex, or Ctrl+C to cancel.'
printf '%s\\n' 'Ctrl+C stops the run. Codex output is written live to the log path above.'
read
set +e
printf '%s\\n' '**VIBE_CODEX_RUN_STARTED**' | tee ${shellQuote(logPath)}
${codexCommand} 2>&1 | tee -a ${shellQuote(logPath)}
VIBE_CODEX_EXIT_CODE=\${PIPESTATUS[0]}
set -e
printf '%s\\n' "__VIBE_CODEX_RUN_EXIT_CODE=\${VIBE_CODEX_EXIT_CODE}" | tee -a ${shellQuote(logPath)}
printf '%s\\n' '**VIBE_CODEX_RUN_FINISHED**' | tee -a ${shellQuote(logPath)}
printf '%s\\n' '__VIBE_CODEX_RUN_FINISHED__' | tee -a ${shellQuote(logPath)}
printf '%s\\n' 'Codex finished.'
printf '%s\\n' 'Press Enter to close.'
read || true
`;
  await fs.writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700, flag: artifactWriteFlag });
  await fs.chmod(scriptPath, 0o700);
  return { runDir, promptPath, logPath, scriptPath, baselineStatusPath, finalStatusPath, metadataPath, script };
}

export async function launchVisibleTerminal(args: {
  scriptPath: string;
  cwd: string;
  config: Config;
  preferredApp: string;
  fallbackApp?: string;
  launch?: boolean;
  opener?: (appName: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string }>;
}) {
  if (args.launch === false) {
    return { terminalApp: args.preferredApp, result: undefined, fallbackUsed: false };
  }
  const opener = args.opener ?? ((appName: string) => runProcessArgv({ file: "open", args: ["-a", appName, args.scriptPath], cwd: args.cwd, timeoutMs: 30_000, maxOutputBytes: args.config.maxCommandOutputBytes }));
  const first = await opener(args.preferredApp);
  if (first.exitCode === 0 || !args.fallbackApp || args.fallbackApp === args.preferredApp) {
    return { terminalApp: args.preferredApp, result: first, fallbackUsed: false };
  }
  const fallback = await opener(args.fallbackApp);
  return { terminalApp: args.fallbackApp, result: fallback, fallbackUsed: true };
}

export async function launchInteractiveCodexTerminal(args: {
  cwd: string;
  prompt: string;
  config: Config;
  preferredApp: string;
  fallbackApp?: string;
  launch?: boolean;
  detectDirectCodexSupport?: () => Promise<boolean>;
  opener?: (appName: string, directCodex: boolean, prompt: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string }>;
}) {
  const supportsDirectCodex = args.detectDirectCodexSupport ?? (() => detectGhosttyDirectCodexSupport(args.preferredApp));
  if (args.launch === false) {
    return { terminalApp: args.preferredApp, result: undefined, fallbackUsed: false, launchedCodexDirectly: false };
  }
  const directCodex = await supportsDirectCodex();
  const opener = args.opener ?? ((appName: string, directCodex: boolean, prompt: string) => {
    const openArgs = directCodex
      ? ["-n", "-a", appName, "--args", `--working-directory=${args.cwd}`, "-e", args.config.codexBin, prompt]
      : appName === args.preferredApp
        ? ["-n", "-a", appName, "--args", `--working-directory=${args.cwd}`]
        : ["-a", appName, args.cwd];
    return runProcessArgv({ file: "open", args: openArgs, cwd: args.cwd, timeoutMs: 30_000, maxOutputBytes: args.config.maxCommandOutputBytes });
  });
  const first = await opener(args.preferredApp, directCodex, args.prompt);
  if (first.exitCode === 0 || !args.fallbackApp || args.fallbackApp === args.preferredApp) {
    return { terminalApp: args.preferredApp, result: first, fallbackUsed: false, launchedCodexDirectly: first.exitCode === 0 && directCodex };
  }
  const fallback = await opener(args.fallbackApp, false, args.prompt);
  return { terminalApp: args.fallbackApp, result: fallback, fallbackUsed: true, launchedCodexDirectly: false };
}

export async function detectGhosttyDirectCodexSupport(appName: string): Promise<boolean> {
  if (!/ghostty/i.test(appName)) return false;
  const candidates = [
    "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    "/Applications/ghostty.app/Contents/MacOS/ghostty",
    path.join(process.env.HOME ?? "", "Applications/Ghostty.app/Contents/MacOS/ghostty"),
    path.join(process.env.HOME ?? "", "Applications/ghostty.app/Contents/MacOS/ghostty"),
  ].filter(Boolean);
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) return false;
  const [help, config] = await Promise.all([
    runProcessArgv({ file: binary, args: ["--help"], timeoutMs: 10_000, maxOutputBytes: 50_000 }).catch(() => undefined),
    runProcessArgv({ file: binary, args: ["+show-config", "--default"], timeoutMs: 10_000, maxOutputBytes: 80_000 }).catch(() => undefined),
  ]);
  const helpText = `${help?.stdout ?? ""}\n${help?.stderr ?? ""}`;
  const configText = `${config?.stdout ?? ""}\n${config?.stderr ?? ""}`;
  return helpText.includes("-e <command>") && configText.includes("working-directory");
}

async function createPromptOnlyRunArtifacts(workspacePath: string, runId: string, prompt: string, executionMode: ExecutionMode, config: Config) {
  const runDir = await ensureRunDir(workspacePath, runId, config);
  const promptPath = await writePrompt(runDir, prompt);
  const rootPromptPath = executionMode === "codex-app-visible"
    ? await writeRootPromptHandoff(workspacePath, runId, promptPath, prompt, config)
    : undefined;
  const baselineStatus = (await gitStatus(workspacePath, config).catch(() => undefined))?.stdout ?? "";
  const { baselineStatusPath, finalStatusPath, metadataPath } = await writeBaselineMetadata({
    runDir,
    runId,
    workspacePath,
    promptPath,
    rootPromptPath,
    baselineStatus,
    executionMode,
  });
  return { runDir, promptPath, rootPromptPath, baselineStatusPath, finalStatusPath, metadataPath };
}

export async function startTerminalVisibleCodexTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
  launch?: boolean;
  executionMode?: "terminal-visible" | "ghostty-visible";
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const capabilities = await inspectCodexExecCapabilities(args.config);
  const baselineStatus = (await gitStatus(cwd, args.config).catch(() => undefined))?.stdout ?? "";
  const executionMode = args.executionMode ?? "terminal-visible";
  const preferredApp = args.config.terminalFallbackApp;
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: "running_visible",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: "pending visible terminal launch",
    metadata: { executionMode, terminalApp: preferredApp },
  });
  const artifacts = await createTerminalVisibleRunArtifacts({ workspacePath: cwd, runId: placeholder.id, prompt: args.prompt, config: args.config, capabilities, baselineStatus, executionMode, terminalApp: preferredApp });
  const launch = await launchVisibleTerminal({
    scriptPath: artifacts.scriptPath,
    cwd,
    config: args.config,
    preferredApp,
    fallbackApp: undefined,
    launch: args.launch,
  });
  return args.runStore.updateRun(placeholder.id, {
    codexCommand: launch.result?.command ?? artifacts.scriptPath,
    stdout: launch.result?.stdout ?? "",
    stderr: launch.result?.stderr ?? "",
    exitCode: launch.result?.exitCode ?? null,
    metadata: {
      executionMode,
      terminalApp: launch.terminalApp,
      terminalFallbackApp: args.config.terminalFallbackApp,
      terminalFallbackUsed: launch.fallbackUsed,
      runDir: artifacts.runDir,
      promptPath: artifacts.promptPath,
      logPath: artifacts.logPath,
      scriptPath: artifacts.scriptPath,
      baselineStatusPath: artifacts.baselineStatusPath,
      finalStatusPath: artifacts.finalStatusPath,
      metadataPath: artifacts.metadataPath,
      launchExitCode: launch.result?.exitCode,
    },
  });
}

export async function startGhosttyInteractiveCodexTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
  launch?: boolean;
  copyClipboard?: boolean;
  opener?: (appName: string, directCodex: boolean, prompt: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string }>;
  detectDirectCodexSupport?: () => Promise<boolean>;
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const baselineStatus = (await gitStatus(cwd, args.config).catch(() => undefined))?.stdout ?? "";
  const preferredApp = args.config.terminalApp;
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: "interactive_ready",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: "interactive codex handoff",
    metadata: { executionMode: "ghostty-visible", terminalApp: preferredApp },
  });
  const runDir = await ensureRunDir(cwd, placeholder.id, args.config);
  const promptPath = await writePrompt(runDir, args.prompt);
  const { baselineStatusPath, finalStatusPath, metadataPath } = await writeBaselineMetadata({
    runDir,
    runId: placeholder.id,
    workspacePath: cwd,
    promptPath,
    baselineStatus,
    executionMode: "ghostty-visible",
    terminalApp: preferredApp,
  });
  const copy = await copyPromptToClipboard({ promptPath, cwd, config: args.config, copy: args.copyClipboard ?? false });
  const launch = await launchInteractiveCodexTerminal({
    cwd,
    prompt: args.prompt,
    config: args.config,
    preferredApp,
    fallbackApp: args.config.terminalFallbackApp,
    launch: args.launch,
    opener: args.opener,
    detectDirectCodexSupport: args.detectDirectCodexSupport,
  });
  return args.runStore.updateRun(placeholder.id, {
    status: launch.launchedCodexDirectly ? "interactive_started" : "interactive_ready",
    codexCommand: launch.result?.command ?? "interactive codex handoff",
    stdout: [copy.stdout, launch.result?.stdout].filter(Boolean).join("\n"),
    stderr: [copy.stderr, launch.result?.stderr].filter(Boolean).join("\n"),
    exitCode: launch.result?.exitCode ?? null,
    metadata: {
      executionMode: "ghostty-visible",
      terminalApp: launch.terminalApp,
      terminalFallbackApp: args.config.terminalFallbackApp,
      terminalFallbackUsed: launch.fallbackUsed,
      launchedCodexDirectly: launch.launchedCodexDirectly,
      promptSubmittedAutomatically: launch.launchedCodexDirectly,
      usesCodexExec: false,
      usesShellScript: false,
      requiresManualPaste: !launch.launchedCodexDirectly,
      runDir,
      promptPath,
      baselineStatusPath,
      finalStatusPath,
      metadataPath,
      copiedToClipboard: copy.copied,
      clipboardExitCode: copy.exitCode,
      launchExitCode: launch.result?.exitCode,
    },
  });
}

export async function startCodexAppVisibleTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
  openApp?: boolean;
  copyClipboard?: boolean;
  executionMode?: "codex-app-visible" | "app-supervised";
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const executionMode = args.executionMode ?? "codex-app-visible";
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: executionMode === "codex-app-visible" ? "app_visible_ready" : "running_visible",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: executionMode === "codex-app-visible" ? "codex app visible prompt handoff" : "app-supervised prompt handoff",
    metadata: { executionMode },
  });
  const artifacts = await createPromptOnlyRunArtifacts(cwd, placeholder.id, args.prompt, executionMode, args.config);
  const appResult = args.openApp === false
    ? undefined
    : await runProcessArgv({ file: args.config.codexBin, args: ["app", cwd], cwd, timeoutMs: 30_000, maxOutputBytes: args.config.maxCommandOutputBytes });
  const copyResult = args.copyClipboard === false
    ? undefined
    : await copyPromptToClipboard({ promptPath: artifacts.promptPath, cwd, config: args.config, copy: true, verify: true, delayBeforeMs: args.openApp === false ? 0 : 750 }).catch(() => undefined);
  return args.runStore.updateRun(placeholder.id, {
    status: executionMode === "codex-app-visible" ? "app_visible_ready" : "running_visible",
    stdout: [appResult?.stdout, copyResult?.stdout].filter(Boolean).join("\n"),
    stderr: [appResult?.stderr, copyResult?.stderr].filter(Boolean).join("\n"),
    exitCode: appResult?.exitCode ?? null,
    metadata: {
      executionMode,
      runDir: artifacts.runDir,
      promptPath: artifacts.promptPath,
      rootPromptPath: artifacts.rootPromptPath,
      baselineStatusPath: artifacts.baselineStatusPath,
      finalStatusPath: artifacts.finalStatusPath,
      metadataPath: artifacts.metadataPath,
      appOpened: appResult ? appResult.exitCode === 0 : false,
      copiedToClipboard: copyResult ? copyResult.copied === true : false,
      clipboardCopied: copyResult ? copyResult.copied === true : false,
      clipboardExitCode: copyResult?.exitCode,
      clipboardVerified: copyResult?.verified === true,
      promptSubmittedAutomatically: false,
      usesCodexExec: false,
      usesShellScript: false,
      requiresManualPaste: true,
    },
  });
}

export async function startAppSupervisedCodexTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
  openApp?: boolean;
  copyClipboard?: boolean;
}): Promise<RunRecord> {
  return startCodexAppVisibleTask({ ...args, executionMode: "app-supervised" });
}

export async function collectVisibleRunResult(args: {
  runId: string;
  config: Config;
  runStore: RunStore;
  maxBytes?: number;
}) {
  const run = args.runStore.getRun(args.runId);
  if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
  const safeArtifact = async (value: unknown) => typeof value === "string"
    ? assertSafeNonSymlinkFilePath(run.workspacePath, path.relative(run.workspacePath, value), args.config)
    : undefined;
  const logPath = await safeArtifact(run.metadata?.logPath);
  const baselineStatusPath = await safeArtifact(run.metadata?.baselineStatusPath);
  const finalStatusPath = await safeArtifact(run.metadata?.finalStatusPath);
  const metadataPath = await safeArtifact(run.metadata?.metadataPath);
  let log = "";
  let truncated = false;
  if (logPath) {
    try {
      const requestedLimit = args.maxBytes ?? args.config.maxCommandOutputBytes;
      const maxBytes = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(4_000_000, Math.floor(requestedLimit))) : args.config.maxCommandOutputBytes;
      const handle = await fs.open(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Log is not a regular file.");
        const length = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
        log = decodeBoundedUtf8(buffer, maxBytes);
        truncated = stat.size > maxBytes;
      } finally {
        await handle.close();
      }
    } catch {
      log = "";
    }
  }
  const changes = await collectWorkspaceChanges(run.workspacePath, args.config, args.maxBytes ?? 80_000).catch(() => ({ gitStatus: "", gitDiffSummary: "", changedFiles: [] as string[], omittedFiles: [] as string[], truncated: true }));
  const statusText = changes.gitStatus;
  if (finalStatusPath) await fs.writeFile(finalStatusPath, statusText, { encoding: "utf8", flag: artifactWriteFlag, mode: 0o600 }).catch(() => undefined);
  const baselineStatus = baselineStatusPath ? await (async () => {
    const handle = await fs.open(baselineStatusPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2_000_000) return "";
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return decodeBoundedUtf8(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  })().catch(() => "") : "";
  const changedFiles = changes.changedFiles;
  const baselineFiles = new Set(parseGitShortStatus(baselineStatus).map((entry) => entry.path));
  const newChangedFilesSinceRun = changedFiles.filter((file) => !baselineFiles.has(file));
  const gitDiffSummary = changes.gitDiffSummary;
  truncated ||= changes.truncated;
  const isInteractiveGhostty = run.metadata?.executionMode === "ghostty-visible";
  const isCodexAppVisible = run.metadata?.executionMode === "codex-app-visible" || run.metadata?.executionMode === "app-supervised";
  const exitCodeMatch = log.match(/^__VIBE_CODEX_RUN_EXIT_CODE=(-?\d+)$/m);
  const visibleExitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1], 10) : undefined;
  const finishedMarker = /^(?:\*\*VIBE_CODEX_RUN_FINISHED\*\*|__VIBE_CODEX_RUN_FINISHED__)$/m.test(log);
  // Dirtiness, assistant prose and a GUI opener's exit code are not task completion evidence.
  const completedVisible = !isInteractiveGhostty && !isCodexAppVisible && finishedMarker && visibleExitCode === 0;
  const failedVisible = !isInteractiveGhostty && !isCodexAppVisible && finishedMarker && visibleExitCode !== undefined && visibleExitCode !== 0;
  const collectedStatus = completedVisible ? "completed_visible" : failedVisible ? "failed_visible" : isInteractiveGhostty ? "unknown_interactive" : isCodexAppVisible ? "unknown_app_visible" : run.status;
  if (collectedStatus !== run.status && (collectedStatus === "completed_visible" || collectedStatus === "failed_visible" || collectedStatus === "unknown_interactive" || collectedStatus === "unknown_app_visible")) {
    args.runStore.updateRun(run.id, { status: collectedStatus });
  }
  if (metadataPath) {
    await fs.writeFile(metadataPath, JSON.stringify({
      runId: run.id,
      workspacePath: run.workspacePath,
      status: collectedStatus,
      visibleExitCode,
      promptPath: run.metadata?.promptPath,
      logPath,
      baselineStatusPath,
      finalStatusPath,
      changedFiles,
      newChangedFilesSinceRun,
      gitDiffSummary,
      collectedAt: new Date().toISOString(),
    }, null, 2), { encoding: "utf8", flag: artifactWriteFlag, mode: 0o600 }).catch(() => undefined);
  }
  return {
    runId: run.id,
    status: collectedStatus,
    executionMode: run.metadata?.executionMode,
    terminalApp: run.metadata?.terminalApp,
    exitCode: visibleExitCode,
    log,
    truncated,
    logPath,
    promptPath: run.metadata?.promptPath,
    scriptPath: run.metadata?.scriptPath,
    finalStatusPath,
    metadataPath,
    baselineStatus,
    gitStatus: statusText,
    gitDiff: gitDiffSummary,
    gitDiffSummary,
    changedFiles,
    omittedFiles: changes.omittedFiles,
    completionKnown: completedVisible || failedVisible,
    newChangedFilesSinceRun,
    changedFilesSinceRun: newChangedFilesSinceRun,
    summary: collectedStatus === "completed_visible"
      ? "Visible Codex run completed with an explicit process exit marker."
      : collectedStatus === "failed_visible"
        ? "Visible Codex run appears to have failed."
        : isInteractiveGhostty ? "Interactive Codex run has no reliable completion marker yet." : isCodexAppVisible ? "Codex Desktop visible run has no reliable completion marker yet." : "Visible Codex run is still pending or running.",
    doNotFallbackToDirectWrite: true,
  };
}

export async function startCodexExecTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const capabilities = await inspectCodexExecCapabilities(args.config);
  const argv = codexArgs(args.prompt, args.config, capabilities);
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: "running",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: [args.config.codexBin, ...argv].join(" "),
  });
  const result = await runProcessArgv({
    file: args.config.codexBin,
    args: argv,
    cwd,
    timeoutMs: args.config.codexTimeoutMs,
    maxOutputBytes: args.config.maxCommandOutputBytes,
  });
  return args.runStore.updateRun(placeholder.id, {
    status: result.exitCode === 0 ? "completed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    metadata: { timedOut: result.timedOut, signal: result.signal, durationMs: result.durationMs },
  });
}

function tail(text: string, bytes = 20_000): string {
  return text.length <= bytes ? text : text.slice(text.length - bytes);
}

export async function continueCodexTask(args: {
  runId: string;
  instruction: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
}): Promise<RunRecord> {
  const prior = args.runStore.getRun(args.runId);
  if (!prior) throw new Error(`Run not found: ${args.runId}`);
  const status = await gitStatus(prior.workspacePath, args.config).catch((error) => ({ stdout: "", stderr: String(error) }));
  const diff = await gitDiff(prior.workspacePath, args.config, 40_000).catch((error) => ({ stdout: "", stderr: String(error) }));
  const prompt = compileCodexPrompt({
    workspacePath: prior.workspacePath,
    userGoal: `Continue prior Vibe Codex run ${prior.id}.\n\nOriginal prompt:\n${prior.prompt}\n\nPrevious stdout tail:\n${tail(prior.stdout)}\n\nPrevious stderr tail:\n${tail(prior.stderr)}\n\nCurrent git status:\n${"stdout" in status ? status.stdout : ""}\n\nCurrent git diff:\n${"stdout" in diff ? tail(diff.stdout, 40_000) : ""}\n\nNew instruction:\n${args.instruction}`,
    autonomy: args.autonomy,
  });
  const run = await startCodexExecTask({ workspacePath: prior.workspacePath, prompt, autonomy: args.autonomy, config: args.config, runStore: args.runStore });
  return args.runStore.updateRun(run.id, { metadata: { ...(run.metadata ?? {}), previousRunId: prior.id } });
}
