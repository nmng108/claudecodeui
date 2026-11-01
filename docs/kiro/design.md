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
| `kiro-models.provider.ts` | Models/agents from `session/new`, static fallback |
| `kiro-sessions.provider.ts` | `normalizeMessage`, `fetchHistory` via `session/load` |
| `kiro-session-synchronizer.provider.ts` | Upsert from `session/list`, `jsonl_path: null` |
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

## Risks
- Kiro installer may pick a glibc build on Alpine. Mitigation: `gcompat`, or document the failure.
- ACP fork/rewind support is unknown. Mitigation: mark unsupported in capabilities.
- Publish may need an OTP. Mitigation: stop and report.
