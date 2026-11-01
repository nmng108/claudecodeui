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
| `kiro-session-synchronizer.provider.ts` | File-based upsert from `.index/index.json` / `session.json`, stores `messages.jsonl` path |
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

Synchronizer rules: prefer `index.json`, fall back to `session.json` when the index is missing or stale or a dir vanished; keep the id prefix; use `workspacePaths[0]` as project path; hide subagent stubs and rewind or fork children; reconcile pending app-created rows like the OpenCode synchronizer; store the `messages.jsonl` path in the session row so the existing prune and delete flows work; fail soft per entry and per line (a throw would stop the scan cursor for every provider); never log message content. A Kiro entry in `sessions-watcher.service.ts` watches `~/.kiro/sessions` for `session.json`, `index.json` and `messages.jsonl` (not `.lock` or `dashboard-search.db*`).

Windows path handling: Kiro stores `workspacePaths` as the client supplied them (for example lowercase `c:\users\admin\.kiro-ui\workspace`). `normalizeProjectPath` keeps case and `projects.project_path` is compared case-sensitively, so the synchronizer matches existing project rows case-insensitively on win32 and reuses their spelling, otherwise uses `fs.realpathSync.native` when the folder exists. It also handles `\\?\`, `/` and trailing separators.

Delete: removes the whole session directory and its `.index` cache entry (see R1.11 for the safeguards). The delete confirmation for Kiro says this also removes the session from Kiro and kiro-ui.

## Risks
- Kiro installer may pick a glibc build on Alpine. Mitigation: `gcompat`, or document the failure.
- ACP fork/rewind support is unknown. Mitigation: mark unsupported in capabilities.
- Publish may need an OTP. Mitigation: stop and report.
- Listing models starts `kiro-cli` and needs a key; without one only the static list shows.
- Deleting Kiro files is irreversible and affects kiro-ui; path-safety and lock checks are mandatory.
- Format drift (`schemaVersion` 2 index, `dataModelVersion` 1 sessions): gate by version and fail soft.
