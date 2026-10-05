# Verification — 2026-10-05

The relay backend successfully executed real Codex turns through OAuth-authenticated MCP. The public tunnel served the updated bridge. ChatGPT web UI authorization/tool execution was not verified: the available test browser was signed out.

## Evidence

| Check | Result | Boundary |
| --- | --- | --- |
| `npm run verify` | Build, 275 tests across 24 files, and MCP smoke passed | Smoke uses a fake Codex app-server |
| `CODEX_MODEL=gpt-5.5 npm run verify:live` | Passed | Real installed Codex CLI 0.144.6 and ChatGPT login; disposable repository/database/listeners |
| Bundled CLI with `CODEX_MODEL=gpt-6.1-sol npm run verify:live` | Passed | Existing desktop-bundled Codex CLI 0.160.0; same OAuth/edit/follow-up/stop checks |
| Owner control | Passed | One-use owner ticket/session, project registration and fixture connection approval through the private HTTP API |
| OAuth/MCP | Passed | Authorization code + PKCE, refresh rotation, MCP initialization, discovery and project tools over local HTTP |
| Actual file editing | Passed | Codex created an untracked text file with a random marker; filesystem contents and collected result matched |
| Conversation continuation | Passed | Same thread, parent run lineage, and second edit using the previous conversation's marker |
| Final answers | Passed | Terminal completion and persisted answers collected through MCP |
| Interruption | Passed | Private owner stop interrupted the exact acknowledged turn; terminal evidence confirmed the result |
| Existing background services | Running | Reinstalled existing LaunchAgents with the Node runtime used to rebuild dependencies; both bridge/workbench listeners bind to loopback |
| Public tunnel health/discovery | Passed | HTTPS `/health` returned 0.3.0; OAuth metadata advertised PKCE, code/refresh grants and the configured MCP resource |
| Public authorization boundary | Passed | Unauthenticated MCP initialization returned 401 with protected-resource discovery; private `/api/state` was absent from the public bridge |
| Public OAuth exchange / ChatGPT web tools | Unverified | Local OAuth success and public reachability do not prove an actual ChatGPT connector session |
| Legacy stored runs | 17 resolved; 2 remain uncertain | Exact history confirmed 14 completed and 3 interrupted turns. Two missing turns still block new tasks in the existing `vibe-codex` workspace |

## Fixes found by verification

- Rebuilt `better-sqlite3`: its installed native module initially targeted a different Node ABI. Pinned the existing LaunchAgents to the working Node executable.
- Added optional `CODEX_MODEL` for managed thread/turn start, continuation and forks. The inherited `gpt-6.1-sol` was advertised by CLI 0.144.6 but rejected by its actual inference path. `gpt-5.5` worked there; the existing bundled CLI 0.160.0 successfully executed with `gpt-6.1-sol`. The ignored local `.env` now selects the bundled binary and verified default model; the repository does not force a model/binary for other installations.
- Fixed the immediate-interrupt race: the app-server can acknowledge a turn before its engine becomes interruptible. Retry only the exact interrupt for the specific “no active turn” rejection, with a two-second bound. Keep live supervision for up to five seconds awaiting a terminal notification; an unconfirmed stop remains uncertain.
- Added recovery for legacy 0.2 nested turn acknowledgments. Import a turn ID only when the saved normalized and raw thread/turn identities agree, then read that exact turn from history. Conflicting identities stay uncertain; task submission is never repeated.
- The Homebrew CLI could not read old paginated threads (`paginated_threads is not supported yet`). Configured the already-installed newer desktop binary with `CODEX_BIN`; no software was installed. This allowed recovery of 17 historical runs. Two exact turn IDs are absent from both full thread history and paginated turn listing; they remain uncertain and have not been replayed, deleted or marked completed.
- Added the repeatable `verify:live` command, with disposable fixture consent, real file-content assertions, same-thread follow-up and confirmed interruption. It revokes its grant and removes its temporary workspace after closing its managed process.
- Removed runtime app-server logs from Git tracking; local copies remain ignored.
- Restarted the previously running 0.2.1 service to serve the verified 0.3.0 code. Saved a private SQLite backup in the ignored owner directory first.

## Scope

Control is through a managed Codex app-server. Codex Desktop window synchronization and automatic GUI supervision are not implemented. A ChatGPT connector must still be connected with OAuth and approved in the local workbench; actual account/UI compatibility needs a signed-in browser test.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server) and [MCP authentication](https://developers.openai.com/plugins/build/auth).
