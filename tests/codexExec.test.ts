import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexExecArgv, collectVisibleRunResult, createTerminalVisibleRunArtifacts, launchInteractiveCodexTerminal, launchVisibleTerminal, startAppSupervisedCodexTask, startCodexAppVisibleTask, startGhosttyInteractiveCodexTask, startTerminalVisibleCodexTask } from "../src/codex/codexExec.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";
import { runProcessArgv } from "../src/util/spawn.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let store: RunStore;
let workspace: string;

beforeEach(async () => {
  ctx = await tempConfig();
  store = initRunStore(ctx.config.databasePath);
  workspace = path.join(ctx.root, "workspace");
  await fs.mkdir(workspace);
});

afterEach(async () => {
  store.db.close();
  await ctx.cleanup();
});

describe("Codex exec integration", () => {
  it("builds args without deprecated --approval", () => {
    const argv = buildCodexExecArgv({
      prompt: "do work",
      sandbox: "workspace-write",
      approval: "untrusted",
      capabilities: {
        supportsSandbox: true,
        supportsExecAskForApproval: false,
        supportsGlobalAskForApproval: true,
      },
    });
    expect(argv).toEqual(["--ask-for-approval", "untrusted", "exec", "--sandbox", "workspace-write", "do work"]);
    expect(argv).not.toContain("--approval");
  });

  it("omits ask-for-approval when unsupported", () => {
    const argv = buildCodexExecArgv({
      prompt: "do work",
      sandbox: "workspace-write",
      approval: "untrusted",
      capabilities: {
        supportsSandbox: true,
        supportsExecAskForApproval: false,
        supportsGlobalAskForApproval: false,
      },
    });
    expect(argv).toEqual(["exec", "--sandbox", "workspace-write", "do work"]);
  });

  it("writes prompt file and safe terminal script for visible runs", async () => {
    const artifacts = await createTerminalVisibleRunArtifacts({
      workspacePath: workspace,
      runId: "run-1",
      prompt: "Build a small thing",
      config: ctx.config,
      capabilities: {
        supportsSandbox: true,
        supportsExecAskForApproval: false,
        supportsGlobalAskForApproval: true,
      },
    });
    await expect(fs.readFile(artifacts.promptPath, "utf8")).resolves.toBe("Build a small thing");
    const script = await fs.readFile(artifacts.scriptPath, "utf8");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("--ask-for-approval");
    expect(script).toContain("--sandbox");
    expect(script).toContain("tee");
    expect(script).toContain("Prompt follows:");
    expect(script).toContain("Press Enter to start Codex, or Ctrl+C to cancel.");
    expect(script).toContain("**VIBE_CODEX_RUN_STARTED**");
    expect(script).toContain("**VIBE_CODEX_RUN_FINISHED**");
    expect(script).toContain("__VIBE_CODEX_RUN_EXIT_CODE=");
    expect(script).toContain("__VIBE_CODEX_RUN_FINISHED__");
    expect(script).toContain("read || true");
    expect(script).toContain("printf '%s\\n'");
    expect(script).not.toContain("echo \"Prompt:");
    expect(script).not.toContain("--approval");
  });

  it("terminal-visible can create a run without launching Terminal in tests", async () => {
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
    });
    expect(run.status).toBe("running_visible");
    expect(typeof run.metadata?.promptPath).toBe("string");
    await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Visible prompt");
  });

  it("ghostty-visible starts interactive codex with initial prompt without run-codex.sh or codex exec", async () => {
    const run = await startGhosttyInteractiveCodexTask({
      workspacePath: workspace,
      prompt: "Ghostty visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
      detectDirectCodexSupport: async () => true,
    });
    expect(run.status).toBe("interactive_ready");
    expect(run.codexCommand).toBe("interactive codex handoff");
    expect(run.metadata?.executionMode).toBe("ghostty-visible");
    expect(run.metadata?.terminalApp).toBe("ghostty");
    expect(run.metadata?.promptSubmittedAutomatically).toBe(false);
    expect(run.metadata?.launchedCodexDirectly).toBe(false);
    expect(run.metadata?.usesCodexExec).toBe(false);
    expect(run.metadata?.usesShellScript).toBe(false);
    expect(run.metadata?.requiresManualPaste).toBe(true);
    expect(run.metadata?.copiedToClipboard).toBe(false);
    expect(run.metadata?.scriptPath).toBeUndefined();
    expect(run.metadata?.logPath).toBeUndefined();
    await expect(fs.access(path.join(run.metadata!.runDir as string, "run-codex.sh"))).rejects.toThrow();
    await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Ghostty visible prompt");
  });

  it("falls back to Terminal when preferred Ghostty launch fails", async () => {
    const attempts: string[] = [];
    const launched = await launchVisibleTerminal({
      scriptPath: "/tmp/run-codex.sh",
      cwd: workspace,
      config: ctx.config,
      preferredApp: "ghostty",
      fallbackApp: "Terminal",
      opener: async (appName) => {
        attempts.push(appName);
        return {
          exitCode: appName === "ghostty" ? 1 : 0,
          stdout: "",
          stderr: appName === "ghostty" ? "not found" : "",
          command: `open -a ${appName}`,
        };
      },
    });
    expect(attempts).toEqual(["ghostty", "Terminal"]);
    expect(launched.terminalApp).toBe("Terminal");
    expect(launched.fallbackUsed).toBe(true);
    expect(launched.result?.exitCode).toBe(0);
  });

  it("interactive Ghostty launcher starts normal codex without exec and falls back to Terminal", async () => {
    const attempts: Array<{ appName: string; directCodex: boolean }> = [];
    const launched = await launchInteractiveCodexTerminal({
      cwd: workspace,
      prompt: "Initial prompt with spaces",
      config: ctx.config,
      preferredApp: "ghostty",
      fallbackApp: "Terminal",
      detectDirectCodexSupport: async () => true,
      opener: async (appName, directCodex) => {
        attempts.push({ appName, directCodex });
        return {
          exitCode: appName === "ghostty" ? 1 : 0,
          stdout: "",
          stderr: appName === "ghostty" ? "not found" : "",
          command: directCodex ? `open -a ${appName} --args --working-directory ${workspace} -e codex Initial prompt with spaces` : `open -a ${appName} ${workspace}`,
        };
      },
    });
    expect(attempts).toEqual([{ appName: "ghostty", directCodex: true }, { appName: "Terminal", directCodex: false }]);
    expect(launched.terminalApp).toBe("Terminal");
    expect(launched.fallbackUsed).toBe(true);
    expect(launched.launchedCodexDirectly).toBe(false);
    expect(launched.result?.command).not.toContain("exec");
  });

  it("interactive Ghostty launcher passes prompt as argv to normal codex", async () => {
    const attempts: Array<{ appName: string; directCodex: boolean; prompt: string }> = [];
    const launched = await launchInteractiveCodexTerminal({
      cwd: workspace,
      prompt: "Initial prompt\nwith newline",
      config: ctx.config,
      preferredApp: "ghostty",
      fallbackApp: "Terminal",
      detectDirectCodexSupport: async () => true,
      opener: async (appName, directCodex, prompt) => {
        attempts.push({ appName, directCodex, prompt });
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          command: "open -n -a ghostty --args --working-directory=<workspace> -e codex <prompt-argv>",
        };
      },
    });
    expect(attempts).toEqual([{ appName: "ghostty", directCodex: true, prompt: "Initial prompt\nwith newline" }]);
    expect(launched.terminalApp).toBe("ghostty");
    expect(launched.launchedCodexDirectly).toBe(true);
    expect(launched.result?.command).not.toContain("exec");
  });

  it("interactive Ghostty launcher opens workspace without codex when direct command is unsupported", async () => {
    const attempts: Array<{ appName: string; directCodex: boolean }> = [];
    const launched = await launchInteractiveCodexTerminal({
      cwd: workspace,
      prompt: "Initial prompt",
      config: ctx.config,
      preferredApp: "ghostty",
      fallbackApp: "Terminal",
      detectDirectCodexSupport: async () => false,
      opener: async (appName, directCodex) => {
        attempts.push({ appName, directCodex });
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          command: directCodex ? `open -a ${appName} -e codex` : `open -a ${appName} ${workspace}`,
        };
      },
    });
    expect(attempts).toEqual([{ appName: "ghostty", directCodex: false }]);
    expect(launched.terminalApp).toBe("ghostty");
    expect(launched.fallbackUsed).toBe(false);
    expect(launched.launchedCodexDirectly).toBe(false);
  });

  it("app-supervised writes prompt and does not run hidden Codex", async () => {
    const run = await startAppSupervisedCodexTask({
      workspacePath: workspace,
      prompt: "Paste this into the app",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      openApp: false,
      copyClipboard: false,
    });
    expect(run.status).toBe("running_visible");
    expect(run.codexCommand).toBe("app-supervised prompt handoff");
    expect(run.metadata?.promptSubmittedAutomatically).toBe(false);
    expect(run.metadata?.requiresManualPaste).toBe(true);
    expect(run.metadata?.usesCodexExec).toBe(false);
    await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Paste this into the app");
    await expect(fs.readFile(run.metadata!.metadataPath as string, "utf8")).resolves.toContain("\"executionMode\": \"app-supervised\"");
    await expect(fs.readFile(run.metadata!.baselineStatusPath as string, "utf8")).resolves.toBe("");
    expect(run.metadata?.appOpened).toBe(false);
  });

  it("codex-app-visible writes prompt/metadata, opens Codex app, copies prompt, and does not use codex exec", async () => {
    const binDir = path.join(ctx.root, "bin");
    const codexLog = path.join(ctx.root, "codex-args.log");
    const clipboardLog = path.join(ctx.root, "clipboard.txt");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "codex"), `#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > ${JSON.stringify(codexLog)}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, "pbcopy"), `#!/usr/bin/env bash\ncat > ${JSON.stringify(clipboardLog)}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, "pbpaste"), `#!/usr/bin/env bash\ncat ${JSON.stringify(clipboardLog)}\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      ctx.config.codexBin = path.join(binDir, "codex");
      const run = await startCodexAppVisibleTask({
        workspacePath: workspace,
        prompt: "Paste this into Codex Desktop",
        autonomy: "workspace",
        config: ctx.config,
        runStore: store,
      });
      expect(run.status).toBe("app_visible_ready");
      expect(run.codexCommand).toBe("codex app visible prompt handoff");
      expect(run.metadata?.executionMode).toBe("codex-app-visible");
      expect(run.metadata?.promptSubmittedAutomatically).toBe(false);
      expect(run.metadata?.requiresManualPaste).toBe(true);
      expect(run.metadata?.usesCodexExec).toBe(false);
      expect(run.metadata?.appOpened).toBe(true);
      expect(run.metadata?.copiedToClipboard).toBe(true);
      expect(run.metadata?.clipboardCopied).toBe(true);
      expect(run.metadata?.clipboardVerified).toBe(true);
      await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Paste this into Codex Desktop");
      await expect(fs.readFile(run.metadata!.rootPromptPath as string, "utf8")).resolves.toContain("Paste this into Codex Desktop");
      await expect(fs.readFile(run.metadata!.metadataPath as string, "utf8")).resolves.toContain("\"executionMode\": \"codex-app-visible\"");
      await expect(fs.readFile(codexLog, "utf8")).resolves.toBe(`app\n${run.workspacePath}\n`);
      await expect(fs.readFile(clipboardLog, "utf8")).resolves.toBe("Paste this into Codex Desktop");
      expect(run.codexCommand).not.toContain("exec");
    } finally {
      process.env.PATH = originalPath;
    }
  }, 15_000);

  it("collects visible completion status and changed files since baseline", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    await fs.writeFile(path.join(workspace, "preexisting.txt"), "before", "utf8");
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
    });
    await fs.writeFile(run.metadata!.logPath as string, "warning: non-fatal\nerror: non-fatal warning text\n__VIBE_CODEX_RUN_EXIT_CODE=0\n**VIBE_CODEX_RUN_FINISHED**\n", "utf8");
    await fs.writeFile(path.join(workspace, "new-file.txt"), "after", "utf8");
    const collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("completed_visible");
    expect(collected.doNotFallbackToDirectWrite).toBe(true);
    expect(collected.gitDiff).toBe(collected.gitDiffSummary);
    expect(collected.scriptPath).toBe(run.metadata!.scriptPath);
    expect(collected.changedFiles).toContain("preexisting.txt");
    expect(collected.changedFiles).toContain("new-file.txt");
    expect(collected.newChangedFilesSinceRun).not.toContain("preexisting.txt");
    expect(collected.newChangedFilesSinceRun).toContain("new-file.txt");
    expect(collected.changedFilesSinceRun).toEqual(collected.newChangedFilesSinceRun);
  });

  it("keeps ordinary assistant prose unknown and preserves tracked filenames/baselines", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    await fs.writeFile(path.join(workspace, " file with spaces.txt"), "before\n");
    await runProcessArgv({ file: "git", args: ["add", "."], cwd: workspace });
    await runProcessArgv({ file: "git", args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"], cwd: workspace });
    await fs.writeFile(path.join(workspace, " file with spaces.txt"), "before run\n");
    const run = await startTerminalVisibleCodexTask({ workspacePath: workspace, prompt: "prompt", autonomy: "workspace", config: ctx.config, runStore: store, launch: false });
    await fs.writeFile(run.metadata!.logPath as string, "Summary of changes:\ntokens used\nCodex finished.\nerror: quoted source code\n");
    await fs.writeFile(path.join(workspace, " file with spaces.txt"), "after run\n");
    await fs.writeFile(path.join(workspace, "new file.txt"), "new\n");
    const result = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(result.status).toBe("running_visible");
    expect(result.completionKnown).toBe(false);
    expect(result.changedFiles).toContain(" file with spaces.txt");
    expect(result.newChangedFilesSinceRun).not.toContain(" file with spaces.txt");
    expect(result.newChangedFilesSinceRun).toContain("new file.txt");
  });

  it("reports manual handoff when direct interactive launch is unsupported", async () => {
    const run = await startGhosttyInteractiveCodexTask({ workspacePath: workspace, prompt: "prompt", autonomy: "workspace", config: ctx.config, runStore: store, detectDirectCodexSupport: async () => false, opener: async () => ({ exitCode: 0, stdout: "", stderr: "", command: "open terminal only" }) });
    expect(run.metadata?.launchedCodexDirectly).toBe(false);
    expect(run.metadata?.promptSubmittedAutomatically).toBe(false);
    expect(run.metadata?.requiresManualPaste).toBe(true);
  });

  it("rejects result artifacts symlinked outside the workspace", async () => {
    const run = await startTerminalVisibleCodexTask({ workspacePath: workspace, prompt: "prompt", autonomy: "workspace", config: ctx.config, runStore: store, launch: false });
    const target = path.join(ctx.root, "outside.log");
    await fs.writeFile(target, "SHOULD_NOT_READ");
    await fs.symlink(target, run.metadata!.logPath as string);
    await expect(collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });

  it("treats finished visible runs with nonzero exit markers as failed", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
    });
    await fs.writeFile(run.metadata!.logPath as string, "__VIBE_CODEX_RUN_EXIT_CODE=1\n**VIBE_CODEX_RUN_FINISHED**\nCodex finished.\n", "utf8");
    const collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("failed_visible");
    expect(collected.exitCode).toBe(1);
  });

  it("collects interactive Ghostty runs from git baseline without codex.log", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    const run = await startGhosttyInteractiveCodexTask({
      workspacePath: workspace,
      prompt: "Interactive prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
      copyClipboard: false,
    });
    let collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("unknown_interactive");
    expect(collected.logPath).toBeUndefined();
    expect(collected.scriptPath).toBeUndefined();
    expect(collected.doNotFallbackToDirectWrite).toBe(true);

    await fs.writeFile(path.join(workspace, "interactive-created.txt"), "created", "utf8");
    collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("unknown_interactive");
    expect(collected.completionKnown).toBe(false);
    expect(collected.changedFilesSinceRun).toContain("interactive-created.txt");
  });

  it("collects codex-app-visible runs from git baseline without codex.log", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    await fs.writeFile(path.join(workspace, "preexisting-untracked.txt"), "before", "utf8");
    const run = await startCodexAppVisibleTask({
      workspacePath: workspace,
      prompt: "GUI prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      openApp: false,
      copyClipboard: false,
    });
    let collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("unknown_app_visible");
    expect(collected.logPath).toBeUndefined();
    expect(collected.scriptPath).toBeUndefined();
    expect(collected.changedFiles).toContain("preexisting-untracked.txt");
    expect(collected.changedFiles).toContain("VIBE_CODEX_PROMPT.md");
    expect(collected.newChangedFilesSinceRun).not.toContain("preexisting-untracked.txt");
    expect(collected.newChangedFilesSinceRun).not.toContain("VIBE_CODEX_PROMPT.md");
    expect(collected.doNotFallbackToDirectWrite).toBe(true);

    await fs.writeFile(path.join(workspace, "gui-created.txt"), "created", "utf8");
    collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("unknown_app_visible");
    expect(collected.completionKnown).toBe(false);
    expect(collected.changedFilesSinceRun).toContain("gui-created.txt");
    expect(collected.changedFilesSinceRun).not.toContain("preexisting-untracked.txt");
    expect(collected.changedFilesSinceRun).not.toContain("VIBE_CODEX_PROMPT.md");
  });
});
