# Kiro Provider: Design

## Architecture

```
UI (provider picker + API-key modal) -> REST/WS -> CloudCLI server
  -> kiro provider (auth, runtime, models, sessions, sessionSynchronizer, mcp, skills)
  -> KiroAcpClient --spawn (env KIRO_API_KEY)--> kiro-cli acp  (ACP ndjson over stdio)
```

Reference implementation for ACP behavior: the kiro-ui repo (`server.ts`, `src/server/notifications.ts`, `.kiro/steering/acp-protocol.md`).

## ACP notes
- `session/prompt` takes `{ sessionId, prompt: [{ type: "text", text }] }`. The turn ends with its response (`stopReason`).
- `session/cancel` is a notification.
- `session/request_permission` is a request; answer with `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
- Kiro extensions arrive as `_kiro.dev/*` notifications (`metadata`, `commands/available`, `session/list_update`, ...). The client forwards those three and ignores any other `_kiro.dev/*` method.

## KIRO_CLI_PATH
`KiroAcpClient` spawns `kiro-cli acp` through `cross-spawn` (so `.cmd` shims work on Windows) with the project path as `cwd`. Set the `KIRO_CLI_PATH` environment variable to run a specific binary instead of the `kiro-cli` found on `PATH`, for example a non-PATH install or the fake ACP agent used in tests. The value is the executable only; the client always appends the `acp` argument. A missing binary fails with `KIRO_CLI_NOT_FOUND`. `KIRO_ACP_INIT_TIMEOUT_MS` (default 20000) bounds the `initialize` handshake.

`KIRO_API_KEY` is set only in the child's environment (copied from `process.env` plus the resolved key). It is never written to `process.env`, logged, or emitted.

## Components (under `server/modules/providers/list/kiro/`)

| File | Role |
| --- | --- |
| `kiro.provider.ts` | Wrapper extending `AbstractProvider`, `super('kiro')` |
| `kiro-api-key.store.ts` | Read/write `~/.cloudcli/kiro-auth.json` (0600, atomic), mask, env precedence |
| `kiro-auth.provider.ts` | `probeCliVersion('kiro-cli')` + key state -> `ProviderAuthStatus` |
| `kiro-acp.client.ts` | Spawns `kiro-cli acp`, wraps `ClientSideConnection`, exposes prompt/cancel/list/load |
| `kiro-runtime.provider.js` | Run/abort, permission bridge, normalized streaming |
| `kiro-models.provider.ts` | Models from `session/new` (`availableModels`, `currentModelId`), TTL cache, static fallback; active model from `session.json` |
| `kiro-paths.ts` | Resolve `~/.kiro/sessions`, find a session dir by id, read `session.json` |
| `kiro-sessions.provider.ts` | `normalizeMessage` (live ACP events), `fetchHistory` from `messages.jsonl` |
| `kiro-session-synchronizer.provider.ts` | File-based upsert from each `session.json`, stores the `messages.jsonl` path |
| `kiro-session-delete.ts` | Guarded removal of a session directory |
| `kiro-mcp.provider.ts` | `~/.kiro/settings/mcp.json`, `<workspace>/.kiro/settings/mcp.json` (format verified against Kiro docs) |
| `kiro-skills.provider.ts` | `~/.kiro/skills`, `<workspace>/.kiro/skills`, prefix `/` |

## Cross-cutting edits
Provider id lists: `server/shared/types.ts`, `src/types/app.ts`, `provider.registry.ts`, `provider.routes.ts`, `agent.routes.ts`, `server/index.ts`, `public/api-docs.html`, `useChatProviderState.ts`, `ProviderSelectionEmptyState.tsx`, `ProviderLoginModal.tsx`, `src/components/mcp/constants.ts`, the provider README, token-usage and capabilities services.

## Security
- Key file mode 0600 in a 0700 directory, atomic write (temp + rename).
- Key validated (non-empty string, bounded length, no whitespace/control characters).
- Never logged, never returned. Spawn env is built per process, not written to `process.env`.

## Docker
`docker/standard/Dockerfile` on `node:24-alpine3.24`: apk build tooling, `@anthropic-ai/claude-code`, Kiro CLI via the official installer (musl verified), then `npm i -g @namng108/cloudcli@${CLOUDCLI_VERSION}` with retry flags. Runs as a non-root user and binds to all interfaces.

## Models and reasoning level
- Built-in models come from the ACP `session/new` response: `models: { currentModelId, availableModels: [{ modelId, name }] }`. `kiro-cli` has no `--list-models`. The catalog adapter spawns one short-lived `KiroAcpClient` (cwd = home folder, key from the store), reads the list and disposes the child. It caches like the OpenCode adapter (TTL, in-flight dedupe, stale-while-revalidate, short TTL when empty, injectable reader and clock) and falls back to a static list (`auto` plus known ids) with no key, no `kiro-cli` or on timeout. The runtime also refreshes the cache from its own `session/new`.
- Reasoning level: `EFFORT_LEVELS` is derived from the capability matrix (`provider-capabilities.service.ts`). Kiro is `supportsEffort: true` with `low, medium, high, xhigh, max`. Levels are really model-dependent (kiro-ui probes `_kiro.dev/commands/options` with `command: 'effort'`); the fixed superset is the validation ceiling and the list is to be confirmed with a live probe when a key is available. The Model library UI needs no change. The runtime validates `options.effort` against the model's declared levels and applies it before the prompt with `_kiro.dev/commands/execute` (command `effort`), falling back to a `/effort <level>` prompt, and persists it in `sessions.effort`.

## Session storage and synchronization (file-based)
Kiro does not advertise standard ACP `session/list`, and `_kiro.dev/session/list` needs a running `kiro-cli` and key, so the synchronizer reads Kiro's files (read-only) under `~/.kiro`:
- `sessions/<wsHash>/.index/index.json`: `{ schemaVersion: 2, entries: [{ id, title, agentMode, createdAt, lastModifiedAt, workspacePaths, status? }], stamps }`. A cache that can lag.
- `sessions/<wsHash>/<sessionDir>/` where `<sessionDir>` is `sess_<uuid>` (ACP or IDE) or `cli_<uuid>_<rand8>` (kiro-cli chat), holding `session.json`, `messages.jsonl`, `.lock`.
- `session.json`: `id, title, agentMode, workspacePaths[], rootPaths[], createdAt, lastModifiedAt, createdReason ('human'|'rewind'|...), parentSessionId, forkedAtMessageId, rootConversationId, modelId, effortLevel, status`. The ACP `sessionId` used by `session/load` is this `id` including the `sess_` or `cli_` prefix.
- `messages.jsonl`: `{ id, timestamp, payload: { type, ... } }`. Types seen: `user`, `assistant` (`operationType: 'Say'`), `turn_start`, `usage_summary`, `session_metadata`, `agent_note`. Tool payloads are confirmed during implementation.
- `sessions/cli/` is the legacy store (mostly empty subagent stubs). Include a legacy session only with content and a non-null title. `sessions/dashboard-search.db*` is never opened.
- `<wsHash>` is not derivable: always read the project path from the index or `session.json`.

Synchronizer rules (as built):
- Every session directory under every workspace directory is read; `session.json` is authoritative. `.index/index.json` and `session-index/*.jsonl` are Kiro caches that can lag, so they are neither read nor edited. Incremental scans skip a session when neither `session.json` nor `messages.jsonl` changed since the cursor.
- The legacy `sessions/cli/` store is not indexed. On this machine it holds only empty subagent stubs; the current kiro-cli writes to `sessions/<wsHash>/` too (`cli_<uuid>_<rand8>`).
- The id keeps its `sess_` or `cli_` prefix. The project path is the first of `workspacePaths` then `rootPaths`.
- A session is listed only when `session.json` parses, it has a project path, and `messages.jsonl` exists and is not empty (a stored path to a missing file would be pruned as an orphan on the next scan).
- Hidden: `createdReason` `subagent` always; `rewind` or `fork` or any `parentSessionId` unless `CLOUDCLI_KIRO_SHOW_BRANCH_SESSIONS` is `true` or `1`. A chain of rewinds is one conversation, so by default only its original shows. With the variable set, every session of the chain is listed.
- A session started in the app is stored under an app id until Kiro's id is known. The synchronizer claims that pending row (`findLatestPendingAppSession`) only when the Kiro session was created no earlier than 10 s before the row, so an old session is never mistaken for it.
- Failures are soft: a bad entry or line is skipped and nothing is thrown out of `synchronize`, because a throw would stop the scan cursor for every provider. Message content is never logged.
- `sessions-watcher.service.ts` watches `~/.kiro/sessions` for `session.json` and `messages.jsonl`, and does not enter `snapshots`, `sub-executions`, `.index` or `cli`, nor report `.lock` or `*.db*` files.

History reader: `messages.jsonl` lines are `{ id, timestamp, payload }`. `user` becomes a user text message; `assistant` with `operationType` `Say` becomes assistant text (with `reasoningModelId` as the model) and `Reasoning` becomes thinking; `tool_call` and `tool_result` share a `toolCallId` and become one `tool_use` message carrying its result (`success: false` marks an error). `agent_note`, `turn_start`, `turn_end`, `usage_summary`, `session_metadata`, `session_event`, `pending_interaction`, `interaction_resolved` and sub-agent markers are skipped. Message ids come from the line number. Pagination uses `sliceTailPage`, so `limit: null` is unbounded and `limit: 0` is an empty page.

Windows path handling: Kiro stores `workspacePaths` as the client supplied them (for example lowercase `c:\users\admin\.kiro-ui\workspace`). `normalizeProjectPath` keeps case and `projects.project_path` is compared case-sensitively, so for Windows-style paths (`C:\`, `C:/`, `\\server`) the synchronizer reuses an existing project (active or archived) that differs only by case, otherwise keeps the path as Kiro wrote it. POSIX paths are never matched loosely. `\\?\`, `/` and trailing separators are handled by `normalizeProjectPath`.

Delete: the sidebar's "Delete permanently" calls the sessions route with `force`, which sets `deletedFromDisk`. For a Kiro session `sessions.service.ts` then calls `deleteKiroSessionFromDisk`, which removes the whole session directory; Projects does the same for each Kiro session when a project is force-deleted. Kiro's own caches (`.index`, `session-index`, `dashboard-search.db`) are left alone and rebuilt by Kiro from the directory listing. Safeguards (all refuse before deleting anything): the path must be `~/.kiro/sessions/<16-hex>/<sess_|cli_ id>` (checked lexically and again after `realpath`, so a symlink cannot lead outside); a `.lock` whose `pid` is alive refuses with `KIRO_SESSION_IN_USE` (409); a turn running in CloudCLI refuses too; a stale lock does not block. The confirmation dialog says that deleting also removes the session from Kiro and kiro-ui. If a session is deleted while an old `session-index` log entry still points at it, Kiro is left to cope with the missing directory.
## Risks
- Kiro installer may pick a glibc build on Alpine. Mitigation: `gcompat`, or document the failure.
- ACP fork/rewind support is unknown. Mitigation: mark unsupported in capabilities.
- Publish may need an OTP. Mitigation: stop and report.
- Listing models starts `kiro-cli` and needs a key; without one only the static list shows.
- Deleting Kiro files is irreversible and affects kiro-ui; path-safety and lock checks are mandatory.
- Format drift (`schemaVersion` 2 index, `dataModelVersion` 1 sessions): gate by version and fail soft.
