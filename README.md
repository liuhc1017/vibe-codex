# Vibe Codex

**ChatGPT for the conversation. Codex for the code. Your Mac for control.**

Vibe Codex is a single-owner local bridge from ChatGPT web to explicitly registered Git projects. Send a task, see progress and permission requests, read the final answer and repository diff, then continue the same Codex conversation. A private local workbench handles setup, project grants, approvals, input, interruption, and recovery.

The default execution path is a managed **Codex app-server**, not Codex Desktop automation. No manual paste is required. It does not synchronize with or supervise the Desktop window.

```text
ChatGPT → tunnel → local MCP/OAuth bridge (127.0.0.1:8787)
                         ↓
                 registered project → Codex turn
                         ↑
Local owner → private workbench (127.0.0.1:8788)
```

## Get started

Requirements: Node.js 20+, Git, and an installed, authenticated Codex CLI. macOS is the supported background-service/legacy GUI platform.

```bash
npm install
cp .env.example .env
```

Set real folders in `.env` (they must exist):

```env
PORT=8787
CONTROL_PORT=8788
ALLOWED_ROOTS=~/Projects,~/codex-work
DEFAULT_PARENT_DIR=~/codex-work
ENABLE_EXPERIMENTAL_OAUTH=true
PUBLIC_BASE_URL=
```

The historical `ENABLE_EXPERIMENTAL_OAUTH` name is retained for compatibility; OAuth is the recommended ChatGPT connection mode. OAuth-only startup does not require `RELAY_TOKEN`. Leave `PUBLIC_BASE_URL` empty until you have chosen your tunnel URL. Local task execution can be tried before connecting ChatGPT.

```bash
codex login status
npm run doctor
npm run build
npm start
```

Startup prints a one-use opening link valid for one minute. To open the workbench again:

```bash
npm run open
# Print a fresh link without opening a browser:
npm run open -- --print
```

1. Open the workbench and check **Get ready**.
2. Register an existing Git repository inside an allowed folder. This grants connected MCP clients access to it; allowed roots alone are not a project grant.
3. Select the project and send a small task locally.
4. Handle any requests under **Your decisions**.
5. Read the final answer and choose **Inspect changes**. Continue the project's conversation for a follow-up.

`npm run dev` is available for development. Doctor is read-only: it checks configuration, Codex version/login, existing roots and app-server availability. It does not start a task, open a tunnel, or prove a successful model turn. Some setup checks will remain blocked until a public URL is configured.

## Connect ChatGPT

Expose **only the bridge port** through a tunnel you control. Never tunnel `CONTROL_PORT` or the raw Codex app-server port.

After choosing a stable HTTPS tunnel URL, set:

```env
PUBLIC_BASE_URL=https://your-tunnel.example
# Optional if the issuer uses the same URL:
OAUTH_ISSUER_BASE_URL=https://your-tunnel.example
ENABLE_EXPERIMENTAL_OAUTH=true
```

Restart the relay after configuration changes. In ChatGPT Developer Mode, add an app/connector using:

```text
Authentication: OAuth
MCP URL: https://your-tunnel.example/mcp
```

Start the connection in ChatGPT, then open the private workbench on your Mac. Check the pending client and exact redirect URI and approve only the request you initiated. The public authorization page waits for that local decision; query parameters, public POST requests and remote `approve_action` calls cannot approve access.

ChatGPT account/UI availability and connector requirements can vary. Automated local tests are not evidence that a particular ChatGPT account successfully connected.

### Other authentication modes

- **Static bearer:** set a strong `RELAY_TOKEN` and use `/mcp` with `Authorization: Bearer …` in clients that support static headers. This is not the same as ChatGPT's OAuth choice.
- **Development URL-token fallback:** `npm run pair` prints a fresh token. Enabling `ALLOW_URL_TOKEN_AUTH=true` permits `/mcp/<URL_TOKEN>` with ChatGPT's “No auth” choice. The URL itself is a credential and can leak into history/logs; prefer OAuth. `npm run pair -- --write-env` explicitly changes `.env`.

Never paste credentials into issues, screenshots, or diagnostics.

## The everyday workflow

In ChatGPT, ask:

> Use my registered “My app” project. Make the requested change, report verification and the final result, and do not commit or push.

The core MCP tools are:

| Job | Tools |
| --- | --- |
| Pick a granted project | `list_projects`, `get_project`, `resume_project` |
| Start or follow up | `start_project_task`, `continue_project_task` |
| Read progress/final answer | `get_run`, `collect_project_result`, `list_project_runs` |
| Inspect changes | `git_status`, `git_diff` |
| Send exact raw thread text | `send_codex_app_thread_message`, `continue_codex_app_thread` |
| Diagnose connection | `relay_health`, `connector_setup_status`, `get_codex_app_server_status` |

Project task tools compile a handoff envelope. Raw-thread aliases send the supplied text without that envelope. Threads must belong to the granted workspace. `list_codex_threads` lists remembered project threads, not every private Desktop conversation.

Tools return a run ID after Codex acknowledges the turn. **`running` is not completion.** Poll the same run/result until `completed`, `failed`, `interrupted`, or a recoverable state. Workspace/thread conflicts block competing turns.

### Decisions and recovery

- Codex command/file decisions are one-use local replies, not persistent sandbox or network grants.
- Structured questions are answered in the workbench. Declared secret-input requests are refused; do not enter passwords or tokens into ordinary answers.
- Relay action approvals expire after ten minutes and bind the exact action. Approve locally, then retry the unchanged tool call. A remote `allowHiddenCodex=true` is not owner consent.
- **Stop task** requests interruption of the exact turn. An acknowledgment alone does not prove it stopped; status reflects notification/history confirmation. Existing edits are kept.
- On disconnect or restart, **Check recovery** reads the exact saved thread/turn. Uncertain work is never automatically resubmitted. If history cannot confirm completion, resolve the original Codex turn locally before starting again.

Repository changes can include pre-existing work. Git dirtiness never proves completion or exclusive authorship. Safe result collection includes staged, unstaged and bounded untracked text while omitting recognized secrets, unsafe symlinks and internal artifacts.

## Configuration and background startup

See `.env.example` for all settings. Important ones:

- `OWNER_DATA_DIR` (default `.vibe-codex/owner`): private opening key and workbench address. Keep it private and out of Git. Startup creates a mode-0700 directory and mode-0600 key; it refuses insecure existing permissions, malformed keys or symlinks rather than replacing your credentials.
- `DATABASE_PATH`: persistent projects, runs, approvals, OAuth grants and hashed credentials. Protect database files and backups; task prompts/output may contain sensitive project information.
- `CODEX_APP_SERVER_MODE=auto`: detect an existing server or start one on loopback when allowed. `manual` uses only `CODEX_APP_SERVER_URL`; `disabled` never starts one.
- `CODEX_APP_SERVER_ISOLATE_MCP_SERVERS=true`: managed startup disables unrelated Codex MCP servers.
- `CODEX_MODEL`: optional model override for managed tasks, including continuation and forks. Blank inherits local Codex configuration. Set a model supported by your CLI login if a turn reports that the configured model is unsupported; catalog discovery alone does not prove inference access.
- Managed turns enforce workspace-write, the project writable root and no network permissions. Permission-expansion requests fail closed.
- `CODEX_TIMEOUT_MS`: bounded turn supervision followed by interruption/reconciliation, not a fabricated terminal failure.
- `REQUIRE_APPROVAL_FOR_CODEX_VISIBLE`, `REQUIRE_APPROVAL_FOR_WRITE_FILE`, and `REQUIRE_APPROVAL_FOR_NORMAL_COMMANDS`: optional additional relay gates. Hidden execution and new project grants always require local consent.

On macOS, optionally install login services **after** local setup works:

```bash
npm run launchd:install
npm run launchd:status
npm run launchd:uninstall
```

Install/uninstall changes installed user LaunchAgents. Service scripts derive their repository and runtime paths, honor configured ports and use `/health` readiness. The tunnel service requires ngrok and a configured `PUBLIC_BASE_URL`. Logs live under `.vibe-codex/launchd/`. Binary overrides include `NODE_BIN`, `NPM_BIN`, `NGROK_BIN`, and `VIBE_CODEX_REPO_DIR`.

## Trust and limitations

This is not a public remote shell or a multi-user service. A connected client can operate all locally registered projects under the configured policy. OAuth grants are single-owner bridge access, not per-project/user isolation.

Owner routes are on a separate loopback listener with one-use bootstrap tickets, HttpOnly/SameSite sessions, Host/Origin validation and CSRF checks. Loopback addresses and OAuth credentials are **not** owner authorization. Owner sessions do not survive process restart; open a fresh link. Local processes running as your OS user can read your files and are outside this boundary.

Command tools execute narrowly validated argv, not shell strings. Build/test scripts still execute trusted repository code; validation does not make a hostile project safe. Codex has its own sandbox/approval boundary, not the command tool's allowlist. Only register repositories and approve actions you trust.

Legacy modes are explicit fallbacks via `start_codex_task`:

- `codex-app-visible` / `app-supervised`: open/copy a Desktop handoff; manual paste, execution/completion not observed.
- `ghostty-visible`: direct argv launch when supported; otherwise a workspace-opening fallback may require manual input. Completion is not inferred from Git changes.
- `terminal-visible`: legacy visible script with log/exit markers.
- `exec-hidden`: synchronous `codex exec`, always one-use owner consent.

There is no automatic Desktop synchronization, background service installation, public deployment, commit or push. Prompt instructions are not a security guarantee. Review changes before committing or sharing them.

## Verification

```bash
npm run build
npm test
npm run verify
```

`verify` builds, runs the regression suite and performs a temporary local MCP smoke: discovery, explicit fixture project grant, asynchronous final answer, same-thread follow-up, correct lineage and safe results against a fake Codex server. It does not touch your existing projects or test a real model/ChatGPT UI.

To test actual execution using your installed Codex CLI and login:

```bash
npm run verify:live
# Optional relay-only model override:
CODEX_MODEL=your-supported-model npm run verify:live
```

This consumes model quota. It starts isolated loopback bridge, workbench and app-server listeners, uses a disposable database/repository, and exercises owner project registration, OAuth authorization/refresh, MCP discovery, a real file edit, a same-thread follow-up, collected final answers and owner interruption. It approves only its disposable fixture connection, revokes that grant, shuts down its listeners and removes its temporary files. Existing projects, grants and global Codex configuration are untouched. It does not prove ChatGPT web UI connectivity or public tunnel operation.

If startup reports a `NODE_MODULE_VERSION` mismatch, run `npm rebuild better-sqlite3` with the same Node executable used by the service, then restart. Reinstall the LaunchAgents with that Node on PATH if their runtime differs from the one used to install dependencies.

If recovery reports `paginated_threads is not supported yet`, use a newer installed CLI via `CODEX_BIN`; a desktop-bundled CLI may be newer than the one on PATH. Legacy 0.2 nested turn acknowledgments are recovered only when their saved identities agree. If the exact turn is missing from history, the run stays uncertain and continues to block new tasks in that workspace.

Optional, deliberately public:

```bash
npm run verify:public
```

This sends OAuth/MCP requests through the configured tunnel, waits for your private-workbench connection approval, lists already granted projects, and revokes its smoke grant afterward. It never autoapproves, registers a project or runs Codex. Do not run it unless you intend to contact that endpoint.

Details: [Feature matrix](docs/FEATURE_MATRIX.md), [OAuth security model](docs/OAUTH_PLAN.md).
