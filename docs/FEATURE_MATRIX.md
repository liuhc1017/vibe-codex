# Feature Matrix

Vibe Codex 0.3 is a single-owner bridge. “Implemented” describes code and regression coverage, not guaranteed compatibility with every ChatGPT account or Codex version.

| Feature | MCP tools/resources | Status | Auth | Paste mode | Tests | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| Durable OAuth | Discovery, `/register`, `/authorize`, `/token`, `/revoke` | Implemented | OAuth + private owner consent | N/A | `oauth.test.ts`, `localControl.test.ts` | Public registration is unauthenticated; exact redirect/PKCE/resource required. Real ChatGPT UI compatibility is a separate check. |
| Private workbench | Separate local listener; `npm run open` | Implemented | Owner key → one-use ticket → HttpOnly session | N/A | `localControl.test.ts`, `application.test.ts` | Never tunnel this port. Sessions are process-local and expire after eight hours. |
| Project grants | `list_projects`, `register_project`, `get_project`, `resume_project` | Implemented | MCP credential + local grant | N/A | `projectRegistry.test.ts`, `mcpHttp.test.ts` | Existing allowed Git projects only; new registrations need local consent. Connected clients share the owner's granted projects. |
| Managed task lifecycle | `start_project_task`, `continue_project_task`, `get_run`, `collect_project_result` | Default | MCP + granted project | No paste | `runCoordinator.test.ts`, `mcpHttp.test.ts` | Retained WS connection and exact-turn terminal evidence; no Desktop sync. |
| Raw thread messages | `send_codex_app_thread_message`, `run_codex_app_thread_turn`, `continue_codex_app_thread` | Implemented | MCP + same-workspace grant | No paste | `mcpHttp.test.ts` | No handoff envelope. Thread listing is limited to remembered project threads. |
| Codex approval/input | Private workbench decisions | Implemented | Owner session + CSRF | N/A | `runCoordinator.test.ts`, `localControl.test.ts` | One-use accept/decline/cancel or question-ID answers; persistent privilege expansion/secret input refused. |
| Interrupt/recovery | Private stop/reconcile; stored exact thread/turn | Implemented | Owner session | N/A | `runCoordinator.test.ts` | Ack is not stop confirmation; uncertain turns block continuation and are never replayed. |
| Relay action approvals | `list_pending_approvals`, `approve_action` guidance | Implemented, durable | Private owner decision | N/A | `approvals.test.ts`, `mcpHttp.test.ts` | Exact action; ten-minute expiry; remote approve calls cannot grant consent. |
| Safe changes | `git_status`, `git_diff`, `collect_project_result` | Implemented | MCP + granted project | N/A | `git.test.ts`, `safety.test.ts`, `results.test.ts` | Staged/unstaged/untracked text is bounded and filtered. Pre-existing work is not attributed to Codex. |
| Workspace commands | `run_workspace_command` | Implemented | MCP + project + autonomy/gate | N/A | `commandRisk.test.ts`, `workspaceCommands.test.ts` | Validated argv only; build/test runs trusted project code, not a secure analysis of hostile scripts. |
| File tools | `list_files`, `read_file`, `write_file` | Implemented | MCP + granted project | N/A | `safety.test.ts`, `workspace.test.ts` | Recognized secrets/path escapes blocked. Direct write is not an authorized fallback after Codex failure. |
| Readiness/setup | `relay_health`, `connector_setup_status`, `vibe://setup`, doctor | Implemented | Read-only local CLI / MCP | N/A | `configAuth.test.ts`, `diagnostics.test.ts`, `mcpHttp.test.ts` | Version/login/process checks do not prove model success; no tunnel management in doctor. |
| Portable macOS startup | LaunchAgent scripts | Implemented, optional | Local operator | N/A | `launchScripts.test.ts` | Installing/uninstalling explicitly changes user services; tunnel targets bridge only. |
| Legacy Desktop delivery | `start_codex_task` with explicit GUI mode | Compatibility fallback | MCP + granted project + optional gate | Manual paste | `codexExec.test.ts`, `mcpHttp.test.ts` | Opening/copying is not execution or completion tracking. |
| Legacy terminal delivery | Explicit `ghostty-visible` / `terminal-visible` | Compatibility fallback | MCP + granted project + gate | Depends on successful launch | `codexExec.test.ts` | Interactive completion unknown; legacy script exit markers are observed separately. |
| Hidden exec | Explicit `exec-hidden` / `continue_codex_task` | Compatibility fallback | Always one-use local consent | No paste | `codexExec.test.ts`, `mcpHttp.test.ts` | Synchronous legacy execution; remote allowHiddenCodex is not consent. |
| URL-token authentication | `/mcp/:urlToken`, query fallback | Development compatibility | URL is credential | N/A | `configAuth.test.ts`, `mcpHttp.test.ts` | Can leak through history/logs. Prefer OAuth. |

## Tool selection

Use project tools for implementation/inspection handoffs, and raw-thread aliases for exact text. Read the returned run ID until terminal status; do not equate a start acknowledgment or a dirty working tree with success. Handle decisions on the private workbench, not via remote approval tools. Never silently replace a failed Codex task with direct file writes or a new workspace.

## Verification boundary

`npm run verify` exercises an isolated fake Codex server through real MCP HTTP. `npm run verify:live` uses the installed Codex login/model quota in a disposable project to test real file changes, same-thread follow-up, final answers and owner interruption over OAuth/MCP; it does not use the public tunnel or ChatGPT UI. `npm run verify:public` deliberately contacts the configured endpoint and waits for owner OAuth consent; it does not run Codex or test ChatGPT's UI. These outcomes must be reported separately.
