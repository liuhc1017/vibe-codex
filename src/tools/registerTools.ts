import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config, AutonomyLevel, AUTONOMY_LEVELS } from "../config/types.js";
import { canRunCodex, canWriteFiles } from "../safety/approvals.js";
import { ApprovalStore, ActionRisk, approvalRequired, requiresApproval } from "../approvals/actionPolicy.js";
import { AuthSessionStore } from "../server/authSessions.js";
import { checkCodexAvailable, getCodexVersion } from "../codex/codexCli.js";
import { createWorkspace as createWorkspaceImpl, WorkspaceTemplate } from "../workspace/createWorkspace.js";
import { listFiles, readFile, writeFile } from "../workspace/files.js";
import { runWorkspaceCommand } from "../workspace/commands.js";
import { gitDiff, gitStatus } from "../workspace/git.js";
import { openCodexApp } from "../codex/codexApp.js";
import { compileCodexPrompt } from "../codex/promptCompiler.js";
import { collectVisibleRunResult, continueCodexTask, ExecutionMode, startAppSupervisedCodexTask, startCodexAppVisibleTask, startCodexExecTask, startGhosttyInteractiveCodexTask, startTerminalVisibleCodexTask } from "../codex/codexExec.js";
import { detectManagedCodexAppServer, startManagedCodexAppServer } from "../codex/codexAppServerManager.js";
import { RunStore } from "../runs/runStore.js";
import { VibeError, toErrorPayload } from "../util/errors.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { classifyCommand } from "../safety/commandRisk.js";
import { authWarnings, buildConnectorUrl } from "../util/connector.js";
import { gitIsRepository } from "../workspace/git.js";
import { getRunCoordinator } from "../codex/runCoordinator.js";
import { startProjectTask, continueProjectTask } from "../codex/projectTasks.js";
import { collectRunResult } from "../runs/results.js";
import { connectorSettings } from "../server/diagnostics.js";

const Autonomy = z.enum(AUTONOMY_LEVELS as [AutonomyLevel, ...AutonomyLevel[]]);
const Template = z.enum(["empty", "node", "python", "vite", "next", "chrome-extension"]);
const ExecutionModeSchema = z.enum(["exec-hidden", "terminal-visible", "ghostty-visible", "codex-app-visible", "app-supervised", "codex-app-thread"]);
const ProjectExecutionModeSchema = z.enum(["codex-app-thread", "codex-app-visible", "ghostty-visible"]);

function toolResult(output: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    structuredContent: output as Record<string, unknown>,
    isError,
  };
}

async function safeTool(fn: () => Promise<unknown>) {
  try {
    return toolResult(await fn());
  } catch (error) {
    return toolResult(toErrorPayload(error), true);
  }
}

async function discoverProjects(config: Config) {
  const projects = [];
  for (const root of config.allowedRoots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        try {
          const workspacePath = await assertSafeWorkspacePath(candidate, config);
          await fs.stat(path.join(workspacePath, ".git"));
          projects.push({ id: `discovered:${workspacePath}`, name: entry.name, path: workspacePath, registered: false });
        } catch {
          // Not a git project.
        }
      }
    } catch {
      // Skip unreadable allowed roots.
    }
  }
  return projects;
}

export function registerTools(server: McpServer, config: Config, runStore: RunStore, stores: { approvals: ApprovalStore; authSessions: AuthSessionStore }) {
  const approvalStore = stores.approvals;

  function maybeApproval(actionRisk: ActionRisk, reason: string, actionSummary: Record<string, unknown>) {
    if (!requiresApproval(config, actionRisk)) return null;
    if (approvalStore.consumeApproved(actionRisk, actionSummary)) return null;
    return approvalRequired(approvalStore.create({ reason, actionRisk, actionSummary }));
  }

  function findRunByCodexThreadId(threadId: string) {
    return runStore.listRuns().find((run) => run.metadata?.codexThreadId === threadId);
  }

  const coordinator = getRunCoordinator(config, runStore);

  function managedRunOutput(run: ReturnType<RunStore["createRun"]>) {
    return {
      runId: run.id, threadId: run.metadata?.codexThreadId, codexThreadId: run.metadata?.codexThreadId,
      turnId: run.metadata?.codexTurnId, sourceThreadId: run.metadata?.sourceCodexThreadId, status: run.status, workspacePath: run.workspacePath,
      summary: run.summary, output: run.stdout, executionMode: "codex-app-thread",
      promptSubmittedAutomatically: true, usesCodexExec: false, usesShellScript: false,
      requiresManualPaste: false, noPaste: true, doNotFallbackToDirectWrite: true,
      nextStep: "Use get_run or collect_project_result with this runId to read progress and the final answer. Approve Codex requests in the local control page.",
    };
  }

  async function grantedWorkspace(inputPath: string) {
    const workspacePath = await assertSafeWorkspacePath(inputPath, config);
    const directory = await fs.stat(workspacePath).catch(() => undefined);
    if (!directory?.isDirectory() || !runStore.getProjectByPath(workspacePath)) {
      throw new VibeError("APPROVAL_REQUIRED", "Register this existing repository in the local control page before allowing the connector to access it.", { workspacePath });
    }
    return workspacePath;
  }

  async function grantedRecordPath(workspacePath: string) {
    const currentPath = await grantedWorkspace(workspacePath).catch(() => undefined);
    if (currentPath !== workspacePath) {
      throw new VibeError("APPROVAL_REQUIRED", "This stored workspace is no longer available to the connector. Select an existing project granted in the local control page.");
    }
  }

  async function accessibleProjects() {
    const candidates = await Promise.all(runStore.listProjects().map(async (project) => {
      await grantedRecordPath(project.path);
      return project;
    }).map((candidate) => candidate.catch(() => undefined)));
    return candidates.filter((project) => project !== undefined);
  }

  async function accessibleRuns(workspacePath?: string) {
    const grantedPaths = new Set((await accessibleProjects()).map((project) => project.path));
    return runStore.listRuns(workspacePath).filter((run) => grantedPaths.has(run.workspacePath));
  }

  async function accessibleApprovals() {
    const candidates = await Promise.all(approvalStore.list("pending").map(async (approval) => {
      const summary = approval.actionSummary;
      if (summary.tool === "create_workspace") {
        await assertSafeWorkspacePath(typeof summary.parentDir === "string" ? summary.parentDir : config.defaultParentDir, config);
      } else if (typeof summary.workspacePath === "string") {
        if (summary.tool === "register_project") await assertSafeWorkspacePath(summary.workspacePath, config);
        else await grantedRecordPath(summary.workspacePath);
      } else return undefined;
      return approval;
    }).map((candidate) => candidate.catch(() => undefined)));
    return candidates.filter((approval) => approval !== undefined);
  }

  function exactApproval(actionRisk: ActionRisk, reason: string, summary: Record<string, unknown>) {
    if (approvalStore.consumeApproved(actionRisk, summary)) return null;
    return approvalRequired(approvalStore.create({ reason, actionRisk, actionSummary: summary }));
  }

  async function resolveProject(projectRef: string) {
    const byId = runStore.getProject(projectRef);
    if (byId) { await grantedRecordPath(byId.path); return byId; }
    const byName = runStore.getProjectByName(projectRef);
    if (byName) { await grantedRecordPath(byName.path); return byName; }
    const safePath = await assertSafeWorkspacePath(projectRef, config).catch(() => undefined);
    if (safePath) {
      const byPath = runStore.getProjectByPath(safePath);
      if (byPath) { await grantedRecordPath(byPath.path); return byPath; }
    }
    throw new VibeError("CONFIG_ERROR", "Registered project not found.", { projectRef });
  }

  function rememberProjectThread(projectId: string, threadId: string | undefined, setDefault = false) {
    if (!threadId) return runStore.touchProject(projectId);
    const project = runStore.getProject(projectId);
    if (!project) throw new VibeError("CONFIG_ERROR", "Project not found.", { projectId });
    const recent = [threadId, ...(project.recentCodexThreadIds ?? []).filter((id) => id !== threadId)].slice(0, 10);
    return runStore.updateProject(projectId, {
      recentCodexThreadIds: recent,
      defaultCodexThreadId: setDefault ? threadId : project.defaultCodexThreadId,
      lastUsedAt: new Date().toISOString(),
    });
  }

  function summarizeRun(run: ReturnType<RunStore["listRuns"]>[number]) {
    return {
      id: run.id,
      workspacePath: run.workspacePath,
      status: run.status,
      autonomy: run.autonomy,
      command: run.codexCommand,
      exitCode: run.exitCode,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      summary: run.summary,
      metadata: {
        executionMode: run.metadata?.executionMode,
        projectId: run.metadata?.projectId,
        codexThreadId: run.metadata?.codexThreadId,
        parentRunId: run.metadata?.parentRunId,
        promptPath: run.metadata?.promptPath,
        metadataPath: run.metadata?.metadataPath,
      },
    };
  }

  function summarizeAuthSession(session: ReturnType<AuthSessionStore["list"]>[number]) {
    return {
      mcpSessionId: session.mcpSessionId,
      authMethod: session.authMethod,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      remoteHost: session.remoteHost,
      userAgent: session.userAgent,
      oauthTokenExpiresAt: session.oauthTokenExpiresAt,
      oauthClientId: session.oauthClientId,
      allowedRootCount: session.allowedRoots.length,
      defaultAutonomy: session.defaultAutonomy,
    };
  }

  async function assertGitWorkspace(workspacePath: string) {
    if (!(await gitIsRepository(workspacePath, config))) {
      throw new VibeError("CONFIG_ERROR", "Workspace is not a Git repository. Run create_workspace with initGit=true or git init first. Vibe Codex will not auto-use --skip-git-repo-check.", { workspacePath });
    }
  }

  async function readDocResource(relativePath: string, fallback: string) {
    try {
      return await fs.readFile(path.join(process.cwd(), relativePath), "utf8");
    } catch {
      return fallback;
    }
  }

  function connectorMode() {
    if (config.enableExperimentalOAuth) return "OAuth";
    if (config.allowUrlTokenAuth) return "No auth with URL token";
    return "Bearer";
  }

  function setupMarkdown() {
    const baseUrl = config.publicBaseUrl ?? "https://<ngrok-url>";
    const mcpUrl = config.enableExperimentalOAuth
      ? `${baseUrl.replace(/\/+$/, "")}/mcp`
      : config.allowUrlTokenAuth
        ? buildConnectorUrl({ baseUrl })
        : `${baseUrl.replace(/\/+$/, "")}/mcp`;
    return `# Vibe Codex Setup

## Local

1. Run \`npm install\`.
2. Copy \`.env.example\` to \`.env\`.
3. Set \`ALLOWED_ROOTS\` to the local project roots ChatGPT may use.
4. Run \`npm run dev\`.

## ChatGPT Developer Mode

- Authentication: \`${config.enableExperimentalOAuth ? "OAuth" : config.allowUrlTokenAuth ? "No auth" : "Bearer if your client supports static headers"}\`
- MCP URL: \`${mcpUrl}\`

For OAuth, set \`ENABLE_EXPERIMENTAL_OAUTH=true\`, \`PUBLIC_BASE_URL=${baseUrl}\`, and \`OAUTH_ISSUER_BASE_URL=${baseUrl}\`.

For URL-token fallback, run \`npm run pair -- --write-env\` and use \`https://<ngrok-url>/mcp/<URL_TOKEN>\`. URL-token auth is development-only.

## First Workflow

1. Open the private workbench with \`npm run open\` and register an existing Git project locally.
2. Approve the OAuth connection in that workbench; remote tools cannot grant consent.
3. Use \`list_projects\` then \`start_project_task\` for implementation work.
4. Poll \`get_run\` for progress and final status; handle Codex decisions in the workbench.
5. Read \`collect_project_result\` and inspect safe changes; use \`continue_project_task\` for same-thread follow-up.
6. Use \`send_codex_app_thread_message\` only for plain messages to a known same-workspace thread.
`;
  }

  function operatorGuideMarkdown() {
    return `# Vibe Codex Operator Guide

## Tool Selection

- \`start_project_task\` and \`continue_project_task\` are for implementation or inspection tasks in registered projects. They add a Vibe Codex handoff envelope.
- \`send_codex_app_thread_message\`, \`run_codex_app_thread_turn\`, and \`continue_codex_app_thread\` send raw/plain text to existing local Codex app threads. They do not add the handoff envelope.
- \`codex-app-thread\` is managed Codex execution; it does not drive or synchronize the Codex Desktop UI.
- \`ghostty-visible\` is legacy terminal delivery. If direct launch is unavailable, the fallback may require manual input; delivery is not completion.
- \`codex-app-visible\` and \`app-supervised\` are manual-paste GUI fallbacks.

## Safety Rules

- Stay inside \`ALLOWED_ROOTS\`.
- Do not read secrets.
- Do not use \`sudo\`.
- Dangerous commands never execute.
- Do not use \`write_file\` as fallback after Codex failure unless the user explicitly authorizes direct writes.
- Do not create a new workspace for a registered project task unless the user explicitly asks for new workspace creation.

## Project Reuse

Register a project once in the private local workbench. A remote \`register_project\` request requires a one-use owner decision there. Continue work by project id, name, or workspace path. \`continue_project_task\` uses the project's default Codex thread when available. \`set_project_default_thread\` only selects a thread already remembered for the same workspace.
`;
  }

  async function checkPublicReachability(baseUrl: string | undefined) {
    if (!baseUrl) return { checked: false, reachable: false, reason: "PUBLIC_BASE_URL is not configured." };
    const normalized = baseUrl.replace(/\/+$/, "");
    const url = config.enableExperimentalOAuth
      ? `${normalized}/.well-known/oauth-protected-resource`
      : `${normalized}/health`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
      const body = await response.text().catch(() => "");
      const ngrokOffline = body.includes("ERR_NGROK_3200") || (body.includes("endpoint") && body.includes("is offline"));
      return {
        checked: true,
        url,
        reachable: response.ok && !ngrokOffline,
        status: response.status,
        reason: ngrokOffline
          ? "ngrok endpoint is offline"
          : response.ok
            ? "reachable"
            : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        checked: true,
        url,
        reachable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  server.registerResource("vibe_status", "vibe://status", {
    title: "Vibe Codex Status",
    description: "JSON status resource for ChatGPT connector diagnostics.",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify({
        version: "0.3.0",
        app: {
          name: "Vibe Codex",
          description: "Tell ChatGPT what to build. Watch Codex do it.",
        },
        authMode: connectorMode(),
        allowedRoots: config.allowedRoots,
        defaultParentDir: config.defaultParentDir,
        connector: {
          setupUrl: config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp` : undefined,
          oauthEnabled: config.enableExperimentalOAuth,
          urlTokenAuthEnabled: config.allowUrlTokenAuth,
          publicReachability: await checkPublicReachability(config.publicBaseUrl),
        },
        codexAppServer: await detectManagedCodexAppServer(config),
        projects: (await accessibleProjects()).slice(0, 20),
        urlTokenAuthEnabled: config.allowUrlTokenAuth,
        recentRuns: (await accessibleRuns()).slice(0, 5).map(summarizeRun),
        pendingApprovals: await accessibleApprovals(),
        authSessions: stores.authSessions.list().slice(0, 10).map(summarizeAuthSession),
        warnings: authWarnings(config),
      }, null, 2),
    }],
  }));

  server.registerResource("vibe_operator_guide", "vibe://operator-guide", {
    title: "Vibe Codex Operator Guide",
    description: "Tool-selection and safety guidance for ChatGPT operating Vibe Codex.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: operatorGuideMarkdown() }],
  }));

  server.registerResource("vibe_feature_matrix", "vibe://feature-matrix", {
    title: "Vibe Codex Feature Matrix",
    description: "Feature coverage, auth, paste mode, test coverage, and known limits.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await readDocResource("docs/FEATURE_MATRIX.md", "# Feature Matrix\n\nFeature matrix documentation is not available."),
    }],
  }));

  server.registerResource("vibe_setup", "vibe://setup", {
    title: "Vibe Codex Setup",
    description: "Concise local setup and ChatGPT Developer Mode connector instructions.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: setupMarkdown() }],
  }));

  server.registerTool("relay_health", {
    description: "Check Vibe Codex relay health, Codex CLI availability, allowed roots, auth mode, and safety warnings.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => {
    const codexVersion = await getCodexVersion(config);
    return {
      status: codexVersion ? "ok" : "degraded",
      version: "0.3.0",
      codexAvailable: !!codexVersion,
      codexVersion: codexVersion ?? undefined,
      terminal: {
        preferredApp: config.terminalApp,
        fallbackApp: config.terminalFallbackApp,
        preferGhostty: config.preferGhostty,
        defaultVisibleMode: config.defaultVisibleMode,
      },
      codexAppServer: await detectManagedCodexAppServer(config),
      allowedRoots: config.allowedRoots,
      defaultParentDir: config.defaultParentDir,
      databasePath: config.databasePath,
      auth: {
        bearerEnabled: !config.disableAuth,
        urlTokenEnabled: config.allowUrlTokenAuth,
        urlTokenExpiresAt: config.urlTokenExpiresAt,
      },
      warnings: authWarnings(config),
    };
  }));

  server.registerTool("connector_setup_status", {
    description: "Show ChatGPT connector setup status, redacted connector URL template, optional public tunnel reachability, recent runs, pending approvals, auth sessions, and safety warnings.",
    inputSchema: z.object({ baseUrl: z.string().url().optional(), recentRunLimit: z.number().int().min(1).max(20).optional(), checkPublicReachability: z.boolean().optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const baseUrl = args?.baseUrl ?? config.publicBaseUrl;
    const recentRuns = (await accessibleRuns()).slice(0, args?.recentRunLimit ?? 5).map(summarizeRun);
    const pendingApprovals = await accessibleApprovals();
    return {
      status: "ok",
      version: "0.3.0",
      chatGptDeveloperMode: {
        authentication: connectorSettings(config).authentication,
        mcpUrl: connectorSettings({ ...config, publicBaseUrl: baseUrl }).mcpUrl,
        oauthEnabled: config.enableExperimentalOAuth,
        urlTokenAuthEnabled: config.allowUrlTokenAuth,
      },
      tunnel: {
        configured: !!baseUrl,
        publicBaseUrl: baseUrl,
        reachability: args?.checkPublicReachability === false ? { checked: false, reason: "disabled by request" } : await checkPublicReachability(baseUrl),
      },
      codex: {
        available: await checkCodexAvailable(config),
        version: await getCodexVersion(config),
      },
      recentRuns,
      pendingApprovals,
      authSessions: stores.authSessions.list().slice(0, 10).map(summarizeAuthSession),
      allowedRoots: config.allowedRoots,
      defaultParentDir: config.defaultParentDir,
      warnings: authWarnings(config),
      noFallbackPolicy: "Never use write_file to satisfy a failed Codex task unless the user explicitly authorizes fallback.",
    };
  }));

  server.registerTool("get_connector_url", {
    description: "Build a redacted ChatGPT Developer Mode MCP URL for a public tunnel base URL.",
    inputSchema: z.object({ baseUrl: z.string().url().optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const baseUrl = args?.baseUrl ?? config.publicBaseUrl;
    if (!baseUrl) throw new VibeError("CONFIG_ERROR", "Provide baseUrl or set PUBLIC_BASE_URL.", {});
    const connectorUsesOAuth = config.enableExperimentalOAuth;
    return {
      authentication: connectorSettings(config).authentication,
      mcpUrl: connectorSettings({ ...config, publicBaseUrl: baseUrl }).mcpUrl,
      tokenRedacted: config.allowUrlTokenAuth && !connectorUsesOAuth,
      oauthEnabled: config.enableExperimentalOAuth,
      urlTokenAuthEnabled: config.allowUrlTokenAuth,
      warnings: authWarnings(config),
    };
  }));

  server.registerTool("list_projects", {
    description: "List known Vibe Codex projects, optionally discovering git repos under allowed roots.",
    inputSchema: z.object({ includeDiscovered: z.boolean().optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const stored = await accessibleProjects();
    const discovered = args?.includeDiscovered ? await discoverProjects(config) : [];
    return { projects: [...stored, ...discovered] };
  }));

  server.registerTool("register_project", {
    description: "Register an existing workspace as a persistent Vibe Codex project. This does not create a new workspace.",
    inputSchema: z.object({
      name: z.string(),
      workspacePath: z.string(),
      repoRemote: z.string().optional(),
      preferredExecutionMode: ProjectExecutionModeSchema.optional(),
      defaultCodexThreadId: z.string().optional(),
      notes: z.string().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const existing = runStore.getProjectByPath(workspacePath);
    if (existing) return { project: existing, reusedExistingWorkspace: true, createdWorkspace: false };
    const approval = exactApproval("write", "Allow this ChatGPT connector to access an existing project.", { tool: "register_project", ...args, workspacePath });
    if (approval) return approval;
    const project = runStore.createProject({ name: args.name, path: workspacePath, repoRemote: args.repoRemote, preferredExecutionMode: args.preferredExecutionMode ?? "codex-app-thread", defaultCodexThreadId: args.defaultCodexThreadId, notes: args.notes });
    return { project, reusedExistingWorkspace: true, createdWorkspace: false };
  }));

  server.registerTool("get_project", {
    description: "Get a registered Vibe Codex project by projectId, name, or workspace path.",
    inputSchema: z.object({ projectRef: z.string() }),
  }, async (args) => safeTool(async () => ({ project: await resolveProject(args.projectRef) })));

  server.registerTool("resume_project", {
    description: "Resolve a registered project and show its default thread and recent runs without creating a workspace.",
    inputSchema: z.object({ projectRef: z.string(), recentRunLimit: z.number().int().min(1).max(20).optional() }),
  }, async (args) => safeTool(async () => {
    const project = runStore.touchProject((await resolveProject(args.projectRef)).id);
    const runs = runStore.listRuns(project.path).filter((run) => run.metadata?.projectId === project.id).slice(0, args.recentRunLimit ?? 10);
    return { project, runs, defaultCodexThreadId: project.defaultCodexThreadId, recentCodexThreadIds: project.recentCodexThreadIds ?? [] };
  }));

  server.registerTool("set_project_default_thread", {
    description: "Select a Codex app-server thread already remembered for the same registered workspace as the project's default.",
    inputSchema: z.object({ projectRef: z.string(), codexThreadId: z.string() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    const mappedRuns = runStore.listRuns().filter((run) => run.metadata?.codexThreadId === args.codexThreadId);
    const remembered = project.defaultCodexThreadId === args.codexThreadId || project.recentCodexThreadIds?.includes(args.codexThreadId);
    if (mappedRuns.some((run) => run.workspacePath !== project.path) || (!remembered && !mappedRuns.some((run) => run.workspacePath === project.path))) {
      throw new VibeError("APPROVAL_REQUIRED", "Select a thread already remembered for this workspace. Resume it explicitly in the registered workspace first; Codex validates its directory before starting a turn.", { projectId: project.id });
    }
    return { project: rememberProjectThread(project.id, args.codexThreadId, true) };
  }));

  server.registerTool("list_project_runs", {
    description: "List persisted Vibe Codex runs for a registered project.",
    inputSchema: z.object({ projectRef: z.string(), limit: z.number().int().min(1).max(50).optional() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    const runs = runStore.listRuns(project.path).filter((run) => run.metadata?.projectId === project.id).slice(0, args.limit ?? 20);
    return { project, runs };
  }));

  server.registerTool("list_project_threads", {
    description: "List remembered Codex thread ids for a registered project.",
    inputSchema: z.object({ projectRef: z.string() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    return { projectId: project.id, defaultCodexThreadId: project.defaultCodexThreadId, recentCodexThreadIds: project.recentCodexThreadIds ?? [] };
  }));

  server.registerTool("start_project_task", {
    description: "Start an implementation or inspection task in an existing registered project. This compiles a Vibe Codex handoff prompt. Do not use it to send a plain message to an existing Codex chat; use list_codex_threads then continue_codex_app_thread instead.",
    inputSchema: z.object({
      projectRef: z.string(),
      userGoal: z.string(),
      executionMode: ProjectExecutionModeSchema.optional(),
      autonomy: Autonomy.optional(),
      codexThreadId: z.string().optional(),
      forkThread: z.boolean().optional(),
      setDefaultThread: z.boolean().optional(),
      context: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
    }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    const workspacePath = await grantedWorkspace(project.path);
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start project tasks.", { autonomy });
    const executionMode = args.executionMode ?? project.preferredExecutionMode ?? "codex-app-thread";
    const approval = maybeApproval("codex-visible", "Codex project execution requires local approval.", { tool: "start_project_task", ...args, workspacePath, autonomy, executionMode });
    if (approval) return approval;
    if (executionMode !== "codex-app-thread") throw new VibeError("CONFIG_ERROR", "Project tasks use managed Codex. Explicit GUI delivery is available through start_codex_task and does not track completion.", { executionMode });
    const run = await startProjectTask(config, runStore, args);
    return { ...managedRunOutput(run), project: runStore.getProject(project.id), createdWorkspace: false };
  }));

  server.registerTool("continue_project_task", {
    description: "Continue an implementation or inspection task for a registered project using the project's default Codex thread. This compiles a Vibe Codex handoff prompt. Do not use it to send a plain message to an existing Codex chat; use continue_codex_app_thread instead.",
    inputSchema: z.object({ projectRef: z.string(), instruction: z.string(), executionMode: ProjectExecutionModeSchema.optional(), autonomy: Autonomy.optional(), codexThreadId: z.string().optional(), setDefaultThread: z.boolean().optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot continue project tasks.", { autonomy });
    if (args.executionMode && args.executionMode !== "codex-app-thread") throw new VibeError("CONFIG_ERROR", "Follow-up tasks use managed Codex.", {});
    const project = await resolveProject(args.projectRef);
    await grantedWorkspace(project.path);
    const approval = maybeApproval("codex-visible", "Codex continuation requires local approval.", { tool: "continue_project_task", ...args, workspacePath: project.path, autonomy });
    if (approval) return approval;
    const run = await continueProjectTask(config, runStore, args);
    return { ...managedRunOutput(run), project: runStore.getProject(project.id), createdWorkspace: false };
  }));

  server.registerTool("collect_project_result", {
    description: "Collect git status/diff and changed files for a project run, updating project-linked run metadata.",
    inputSchema: z.object({ runId: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => {
    const run = runStore.getRun(args.runId);
    if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
    await grantedRecordPath(run.workspacePath);
    return collectRunResult(config, runStore, args.runId, args.maxBytes);
  }));

  server.registerTool("create_workspace", {
    description: "Create a new workspace under an allowed root with an optional starter template.",
    inputSchema: z.object({
      name: z.string(),
      parentDir: z.string().optional(),
      template: Template.optional(),
      initGit: z.boolean().optional(),
      createAgentsMd: z.boolean().optional(),
      autonomy: Autonomy.optional(),
      userNotes: z.string().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canWriteFiles(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot create workspaces.", { autonomy });
    const gate = exactApproval("write", "Creating a new workspace requires local owner approval.", { tool: "create_workspace", ...args, autonomy });
    if (gate) return gate;
    const result = await createWorkspaceImpl({
      name: args.name,
      parentDir: args.parentDir,
      template: args.template as WorkspaceTemplate | undefined,
      initGit: args.initGit ?? true,
      createAgentsMd: args.createAgentsMd ?? true,
      autonomy,
      userNotes: args.userNotes,
      config,
    });
    const project = runStore.createProject({ name: args.name, path: result.workspacePath });
    return { ...result, projectId: project.id };
  }));

  server.registerTool("list_files", {
    description: "List safe files inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), relativeDir: z.string().optional(), maxDepth: z.number().int().min(0).max(10).optional() }),
  }, async (args) => safeTool(async () => ({ files: await listFiles(await grantedWorkspace(args.workspacePath), args.relativeDir, args.maxDepth ?? 3, config) })));

  server.registerTool("read_file", {
    description: "Read a safe non-secret file inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), relativePath: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => readFile(await grantedWorkspace(args.workspacePath), args.relativePath, config, args.maxBytes ?? 200_000)));

  server.registerTool("write_file", {
    description: "Write a file inside a workspace when autonomy allows writes. Do not use direct write_file as fallback for a failed Codex task unless the user explicitly authorizes fallback.",
    inputSchema: z.object({ workspacePath: z.string(), relativePath: z.string(), content: z.string(), overwrite: z.boolean().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canWriteFiles(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot write files.", { autonomy });
    const workspacePath = await grantedWorkspace(args.workspacePath);
    const approval = maybeApproval("write", "Direct file writes require local approval.", {
      tool: "write_file",
      workspacePath,
      relativePath: args.relativePath,
      contentHash: createHash("sha256").update(args.content).digest("hex"),
      overwrite: args.overwrite ?? false,
      autonomy,
    });
    if (approval) return approval;
    const result = await writeFile(workspacePath, args.relativePath, args.content, args.overwrite ?? false, config);
    return { ...result, directWrite: true, doNotUseAsCodexFallbackWithoutUserApproval: true };
  }));

  server.registerTool("run_workspace_command", {
    description: "Run a risk-classified command inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), command: z.string(), autonomy: Autonomy.optional(), timeoutMs: z.number().int().positive().optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    await grantedWorkspace(args.workspacePath);
    const classified = classifyCommand(args.command);
    if (classified.risk === "normal") {
      const approval = maybeApproval("execute", "Normal workspace commands require local approval.", {
        tool: "run_workspace_command",
        workspacePath: args.workspacePath,
        command: args.command,
        autonomy,
      });
      if (approval) return approval;
    }
    return runWorkspaceCommand({ workspacePath: args.workspacePath, command: args.command, autonomy, timeoutMs: args.timeoutMs, config });
  }));

  server.registerTool("open_in_codex_app", {
    description: "Open a workspace in the Codex desktop app for visual supervision.",
    inputSchema: z.object({ workspacePath: z.string() }),
  }, async (args) => safeTool(async () => {
    const workspacePath = await grantedWorkspace(args.workspacePath);
    const approval = maybeApproval("codex-visible", "Opening Codex Desktop requires local approval.", { tool: "open_in_codex_app", workspacePath });
    if (approval) return approval;
    const result = await openCodexApp(workspacePath, config);
    return { opened: result.exitCode === 0, command: result.command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }));

  server.registerTool("start_codex_task", {
    description: "Compile a precise prompt and start a Codex task. Hidden Codex requires explicit approval; direct write_file must not be used as fallback after a failed Codex task unless the user explicitly authorizes fallback.",
    inputSchema: z.object({
      workspacePath: z.string(),
      userGoal: z.string(),
      context: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      nonGoals: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
      autonomy: Autonomy.optional(),
      openApp: z.boolean().optional(),
      executionMode: ExecutionModeSchema.optional(),
      allowHiddenCodex: z.boolean().optional(),
      skipGitRepoCheckAllowed: z.boolean().optional(),
      codexThreadId: z.string().optional(),
      continueExistingThread: z.boolean().optional(),
      forkThread: z.boolean().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const executionMode = (args.executionMode ?? "codex-app-thread") as ExecutionMode;
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex tasks.", { autonomy });
    const workspacePath = await grantedWorkspace(args.workspacePath);
    if (!args.skipGitRepoCheckAllowed) await assertGitWorkspace(workspacePath);
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, context: args.context, constraints: args.constraints, nonGoals: args.nonGoals, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification, autonomy });

    if (executionMode === "ghostty-visible") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "Interactive Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
      });
      if (approval) return approval;
      const run = await startGhosttyInteractiveCodexTask({ workspacePath, prompt, autonomy, config, runStore });
      return {
        runId: run.id,
        status: run.status,
        executionMode,
        terminalApp: run.metadata?.terminalApp,
        workspacePath,
        promptPath: run.metadata?.promptPath,
        copiedToClipboard: run.metadata?.copiedToClipboard === true,
        launchedCodexDirectly: run.metadata?.launchedCodexDirectly === true,
        promptSubmittedAutomatically: run.metadata?.promptSubmittedAutomatically === true,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: run.metadata?.promptSubmittedAutomatically !== true,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: run.metadata?.launchedCodexDirectly === true
          ? "Ghostty opened normal interactive Codex with the prompt submitted as the initial Codex prompt. No script, codex exec, shell pipe, or GUI typing was used."
          : `${String(run.metadata?.terminalApp ?? "Terminal")} opened in the workspace. Type \`codex\` and use the prompt saved at ${String(run.metadata?.promptPath ?? "prompt.md")}. No script, codex exec, shell pipe, or GUI typing was used.`,
      };
    }

    if (executionMode === "terminal-visible") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "Visible Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
      });
      if (approval) return approval;
      const run = await startTerminalVisibleCodexTask({ workspacePath, prompt, autonomy, config, runStore, executionMode });
      return {
        runId: run.id,
        status: run.status,
        executionMode,
        terminalApp: run.metadata?.terminalApp,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        logPath: run.metadata?.logPath,
        scriptPath: run.metadata?.scriptPath,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: "Codex is staged in a macOS Terminal window using the legacy visible script. The terminal shows the exact prompt and waits for Enter before starting. Ctrl+C cancels or stops the run.",
      };
    }

    if (executionMode === "codex-app-thread") {
      const approval = maybeApproval("codex-visible", "Codex execution requires local approval.", { tool: "start_codex_task", ...args, workspacePath, autonomy, executionMode });
      if (approval) return approval;
      return managedRunOutput(await coordinator.start({ workspacePath, prompt, autonomy, threadId: args.codexThreadId, fork: args.forkThread, projectId: runStore.getProjectByPath(workspacePath)?.id }));
    }

    if (executionMode === "codex-app-visible") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "Codex Desktop visible execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
      });
      if (approval) return approval;
      const run = await startCodexAppVisibleTask({ workspacePath, prompt, autonomy, config, runStore, openApp: true, copyClipboard: true });
      return {
        runId: run.id,
        status: run.status,
        executionMode,
        workspacePath,
        promptPath: run.metadata?.promptPath,
        rootPromptPath: run.metadata?.rootPromptPath,
        metadataPath: run.metadata?.metadataPath,
        copiedToClipboard: run.metadata?.copiedToClipboard === true,
        clipboardVerified: run.metadata?.clipboardVerified === true,
        appOpened: run.metadata?.appOpened,
        promptSubmittedAutomatically: false,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: true,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: "Manual-paste delivery only. Check appOpened and clipboardVerified before pasting. Vibe Codex does not observe Desktop execution or completion.",
      };
    }

    if (executionMode === "app-supervised") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "App-supervised Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
      });
      if (approval) return approval;
      const run = await startAppSupervisedCodexTask({ workspacePath, prompt, autonomy, config, runStore, openApp: true, copyClipboard: true });
      return {
        runId: run.id,
        status: run.status,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        metadataPath: run.metadata?.metadataPath,
        appOpened: run.metadata?.appOpened,
        clipboardCopied: run.metadata?.clipboardCopied,
        promptSubmittedAutomatically: false,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: true,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: "Codex app has been opened. The prompt was copied to the clipboard if pbcopy was available; paste it into Codex app to run visibly.",
      };
    }

    const hiddenApprovalSummary = {
      tool: "start_codex_task",
      executionMode,
      workspacePath,
      userGoal: args.userGoal,
      autonomy,
      allowHiddenCodex: args.allowHiddenCodex === true,
      skipGitRepoCheckAllowed: args.skipGitRepoCheckAllowed === true,
    };
    const approval = exactApproval("codex-hidden", "Hidden execution requires one-use local owner consent.", { ...hiddenApprovalSummary, promptHash: createHash("sha256").update(prompt).digest("hex") });
    if (approval) return { ...approval, doNotFallbackToDirectWrite: true };
    if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
    if (args.openApp) await openCodexApp(workspacePath, config);
    const run = await startCodexExecTask({ workspacePath, prompt, autonomy, config, runStore });
    const status = await gitStatus(workspacePath, config).catch(() => undefined);
    const diff = await gitDiff(workspacePath, config, 80_000).catch(() => undefined);
    return {
      runId: run.id,
      status: run.status,
      workspacePath,
      prompt,
      codexStdout: run.stdout,
      codexStderr: run.stderr,
      exitCode: run.exitCode,
      gitStatus: status?.stdout,
      gitDiffSummary: diff?.stdout,
      doNotFallbackToDirectWrite: true,
    };
  }));

  server.registerTool("collect_visible_run_result", {
    description: "Collect prompt/log/git status/git diff for a visible or interactive Vibe Codex run.",
    inputSchema: z.object({ runId: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => {
    const run = runStore.getRun(args.runId);
    if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
    await grantedRecordPath(run.workspacePath);
    return collectVisibleRunResult({ runId: args.runId, config, runStore, maxBytes: args.maxBytes });
  }));

  server.registerTool("detect_codex_app_server", {
    description: "Detect whether a local Codex app-server is reachable through Vibe Codex manager. Does not start it.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => detectManagedCodexAppServer(config)));

  server.registerTool("start_codex_app_server", {
    description: "Start or connect to a local 127.0.0.1 Codex app-server for no-paste codex-app-thread execution.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => startManagedCodexAppServer(config)));

  server.registerTool("stop_codex_app_server", {
    description: "Stop the Codex app-server process started by Vibe Codex. Does not stop externally managed servers.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => ({ ownerActionRequired: true, nextStep: "Stop active tasks from the local control page. Server shutdown is a local operator action." })));

  server.registerTool("restart_codex_app_server", {
    description: "Restart the Vibe Codex-managed local Codex app-server.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => ({ ownerActionRequired: true, nextStep: "Restart the relay locally after stopping active tasks." })));

  server.registerTool("get_codex_app_server_status", {
    description: "Get current Vibe Codex app-server manager status including URL, transport, PID, and last error.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => detectManagedCodexAppServer(config)));

  server.registerTool("list_codex_threads", {
    description: "List remembered Codex app-server threads belonging to currently granted local projects. Use a known thread id before sending a plain follow-up with continue_codex_app_thread. This does not enumerate unrelated local chats.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => {
    const threads = (await accessibleRuns()).filter((run) => typeof run.metadata?.codexThreadId === "string");
    const seen = new Set<string>();
    return { threads: threads.filter((run) => { const id = String(run.metadata!.codexThreadId); if (seen.has(id)) return false; seen.add(id); return true; }).map((run) => ({ id: run.metadata!.codexThreadId, cwd: run.workspacePath, preview: run.summary ?? run.prompt.slice(0,160), status: run.status })) };

  }));

  server.registerTool("start_codex_app_thread", {
    description: "Start a new local Codex app-server thread for a safe workspace. This compiles a normal Codex task prompt for new work. For an existing named chat, use list_codex_threads then continue_codex_app_thread.",
    inputSchema: z.object({ workspacePath: z.string(), userGoal: z.string().describe("Goal for a new Codex task, not a plain message to an existing chat."), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex app threads.", { autonomy });
    const workspacePath = await grantedWorkspace(args.workspacePath);
    const approval = maybeApproval("codex-visible", "Codex execution requires local approval.", { tool: "start_codex_app_thread", ...args, workspacePath, autonomy });
    if (approval) return approval;
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, autonomy });
    const run = await coordinator.start({ workspacePath, prompt, autonomy, projectId: runStore.getProjectByPath(workspacePath)?.id });
    return managedRunOutput(run);
  }));

  server.registerTool("resume_codex_app_thread", {
    description: "Resume an existing local Codex app-server thread in a safe workspace. If prompt is provided, it is sent as raw Codex input without a Vibe project handoff envelope.",
    inputSchema: z.object({ threadId: z.string(), workspacePath: z.string(), prompt: z.string().describe("Optional raw text to submit to the existing Codex thread.").optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const workspacePath = await grantedWorkspace(args.workspacePath);
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot resume tasks.", { autonomy });
    if (!args.prompt) return { threadId: args.threadId, status: "not_started", nextStep: "Provide a prompt to resume, or use get_codex_app_thread_status." };
    const approval = maybeApproval("codex-visible", "Codex execution requires local approval.", { tool: "resume_codex_app_thread", ...args, workspacePath, autonomy });
    if (approval) return approval;
    return managedRunOutput(await coordinator.start({ threadId: args.threadId, workspacePath, prompt: args.prompt, autonomy, projectId: runStore.getProjectByPath(workspacePath)?.id }));
  }));

  async function runLocalCodexThreadTurn(args: { threadId: string; instruction: string; workspacePath?: string; autonomy?: AutonomyLevel }) {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot continue Codex app threads.", { autonomy });
    const priorRun = findRunByCodexThreadId(args.threadId);
    const inputPath = args.workspacePath ?? priorRun?.workspacePath;
    if (!inputPath) throw new VibeError("CONFIG_ERROR", "Provide a registered workspace for this thread.", { threadId: args.threadId });
    const workspacePath = await grantedWorkspace(inputPath);
    const approval = maybeApproval("codex-visible", "Codex thread continuation requires local approval.", { tool: "continue_codex_app_thread", ...args, workspacePath, autonomy });
    if (approval) return approval;
    return managedRunOutput(await coordinator.start({ threadId: args.threadId, workspacePath, prompt: args.instruction, autonomy, projectId: runStore.getProjectByPath(workspacePath)?.id, parentRunId: priorRun?.id }));
  }

  server.registerTool("continue_codex_app_thread", {
    description: "Send raw text as a local Codex app-server turn in an existing Codex chat/thread on this Mac. Use this when the user asks to send a plain message to a named Codex app chat. This targets the user's local code agent, not a person or external messaging service, and it does not add a Vibe Codex handoff envelope.",
    inputSchema: z.object({
      threadId: z.string().describe("Existing Codex app-server thread id, usually found with list_codex_threads."),
      instruction: z.string().describe("Raw text to submit to the existing Codex chat/thread. Do not wrap this in a Vibe Codex handoff envelope for simple message delivery."),
      workspacePath: z.string().optional().describe("Safe workspace path for the thread when Vibe Codex has no prior run mapping."),
      autonomy: Autonomy.optional(),
    }),
  }, async (args) => safeTool(async () => {
    return runLocalCodexThreadTurn(args);
  }));

  server.registerTool("run_codex_app_thread_turn", {
    description: "Alias for continue_codex_app_thread. Send one raw no-paste turn to an existing local Codex app chat/thread. Use this for simple message delivery; it does not create a project task and does not add a Vibe Codex handoff envelope.",
    inputSchema: z.object({
      threadId: z.string().describe("Existing Codex app-server thread id, usually found with list_codex_threads."),
      instruction: z.string().optional().describe("Raw text to submit exactly as the Codex app thread turn."),
      task: z.string().optional().describe("Deprecated alias for instruction, kept for older ChatGPT tool handles."),
      workspacePath: z.string().optional().describe("Safe workspace path for the thread when Vibe Codex has no prior run mapping."),
      autonomy: Autonomy.optional(),
    }).refine((value) => !!(value.instruction ?? value.task), { message: "instruction or task is required" }),
  }, async (args) => safeTool(async () => {
    return runLocalCodexThreadTurn({ threadId: args.threadId, instruction: args.instruction ?? args.task!, workspacePath: args.workspacePath, autonomy: args.autonomy });
  }));

  server.registerTool("send_codex_app_thread_message", {
    description: "Send a plain raw message to an existing local Codex app chat/thread by thread id. Use list_codex_threads first when the user names a Codex chat. This is no-paste app-server delivery and does not add a Vibe Codex handoff envelope.",
    inputSchema: z.object({
      threadId: z.string().describe("Existing Codex app-server thread id, usually found with list_codex_threads."),
      message: z.string().describe("Plain message text to submit exactly to the Codex chat/thread."),
      workspacePath: z.string().optional().describe("Safe workspace path for the thread when Vibe Codex has no prior run mapping."),
      autonomy: Autonomy.optional(),
    }),
  }, async (args) => safeTool(async () => {
    return runLocalCodexThreadTurn({ threadId: args.threadId, instruction: args.message, workspacePath: args.workspacePath, autonomy: args.autonomy });
  }));

  server.registerTool("fork_codex_app_thread", {
    description: "Fork an experimental Codex app-server thread into a safe workspace.",
    inputSchema: z.object({ threadId: z.string(), workspacePath: z.string(), instruction: z.string().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot fork Codex app threads.", { autonomy });
    const workspacePath = await grantedWorkspace(args.workspacePath);
    if (!args.instruction) throw new VibeError("CONFIG_ERROR", "Provide an instruction for the new forked task.", {});
    const approval = maybeApproval("codex-visible", "Forked Codex execution requires local approval.", { tool: "fork_codex_app_thread", ...args, workspacePath, autonomy });
    if (approval) return approval;
    return managedRunOutput(await coordinator.start({ threadId: args.threadId, fork: true, workspacePath, prompt: args.instruction, autonomy, projectId: runStore.getProjectByPath(workspacePath)?.id, parentRunId: findRunByCodexThreadId(args.threadId)?.id }));
  }));

  server.registerTool("get_codex_app_thread_status", {
    description: "Get experimental Codex app-server thread status.",
    inputSchema: z.object({ threadId: z.string() }),
  }, async (args) => safeTool(async () => {
    const run = findRunByCodexThreadId(args.threadId);
    if (!run) throw new VibeError("APPROVAL_REQUIRED", "This thread has no granted project mapping. Start a task in a registered project first.", {});
    await grantedRecordPath(run.workspacePath);
    if (run.status === "recovery_required" || run.status === "recovering") await coordinator.reconcile(run.id);
    const updated = runStore.getRun(run.id)!;
    return { ...managedRunOutput(updated), run: updated };
  }));

  server.registerTool("list_recent_runs", {
    description: "List recent Vibe Codex runs with status, workspace, execution mode, and key artifact paths.",
    inputSchema: z.object({ workspacePath: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const workspace = args?.workspacePath ? await grantedWorkspace(args.workspacePath) : undefined;
    const runs = (await accessibleRuns(workspace)).slice(0, args?.limit ?? 10);
    return { runs };
  }));

  server.registerTool("continue_codex_task", {
    description: "Approximate continuation by running another hidden codex exec with saved run context. Hidden Codex requires explicit approval; do not use direct write_file as fallback unless the user explicitly authorizes fallback.",
    inputSchema: z.object({ runId: z.string(), instruction: z.string(), autonomy: Autonomy.optional(), allowHiddenCodex: z.boolean().optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot continue Codex tasks.", { autonomy });
    const prior = runStore.getRun(args.runId);
    const summary = { tool: "continue_codex_task", runId: args.runId, workspacePath: prior?.workspacePath, autonomy, allowHiddenCodex: args.allowHiddenCodex === true };
    if (!prior) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
    await grantedRecordPath(prior.workspacePath);
    const approval = exactApproval("codex-hidden", "Hidden continuation requires one-use local owner consent.", { ...summary, instruction: args.instruction });
    if (approval) return { ...approval, doNotFallbackToDirectWrite: true };
    const run = await continueCodexTask({ runId: args.runId, instruction: args.instruction, autonomy, config, runStore });
    const status = await gitStatus(run.workspacePath, config).catch(() => undefined);
    const diff = await gitDiff(run.workspacePath, config, 80_000).catch(() => undefined);
    return {
      runId: run.id,
      previousRunId: run.metadata?.previousRunId,
      status: run.status,
      codexStdout: run.stdout,
      codexStderr: run.stderr,
      exitCode: run.exitCode,
      gitStatus: status?.stdout,
      gitDiffSummary: diff?.stdout,
      doNotFallbackToDirectWrite: true,
    };
  }));

  server.registerTool("approve_action", {
    description: "Explain how to approve an action in the private local workbench. This remote tool cannot grant approval.",
    inputSchema: z.object({ approvalId: z.string() }),
  }, async (args) => safeTool(async () => {
    return { approvalRequired: true, approvalId: args.approvalId, nextStep: "Only the local owner can approve this action. Open the Vibe Codex control page on this Mac." };
  }));

  server.registerTool("list_pending_approvals", {
    description: "List pending Vibe Codex local approval gates.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => ({ approvals: await accessibleApprovals() })));

  server.registerTool("reject_action", {
    description: "Reject a pending Vibe Codex local action gate.",
    inputSchema: z.object({ approvalId: z.string(), reason: z.string().optional() }),
  }, async (args) => safeTool(async () => {
    if (!(await accessibleApprovals()).some((approval) => approval.id === args.approvalId)) {
      throw new VibeError("CONFIG_ERROR", "Pending approval not found for an accessible workspace.", { approvalId: args.approvalId });
    }
    const approval = approvalStore.reject(args.approvalId, args.reason);
    if (!approval) throw new VibeError("CONFIG_ERROR", "Approval not found.", { approvalId: args.approvalId });
    return { approval };
  }));

  server.registerTool("get_run", {
    description: "Get a stored Codex run record.",
    inputSchema: z.object({ runId: z.string() }),
  }, async (args) => safeTool(async () => {
    const run = runStore.getRun(args.runId);
    if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
    await grantedRecordPath(run.workspacePath);
    return { run };
  }));

  server.registerTool("git_status", {
    description: "Get git status for a workspace.",
    inputSchema: z.object({ workspacePath: z.string() }),
  }, async (args) => safeTool(async () => ({ status: (await gitStatus(await grantedWorkspace(args.workspacePath), config)).stdout })));

  server.registerTool("git_diff", {
    description: "Get git diff for a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => {
    const result = await gitDiff(await grantedWorkspace(args.workspacePath), config, args.maxBytes ?? 200_000);
    return { diff: result.stdout, truncated: result.stdout.includes("[output truncated]") };
  }));
}
