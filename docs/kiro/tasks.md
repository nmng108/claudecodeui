# Kiro Work: Task List

Requirements: `spec.md`. Design: `design.md`. Branch: `feature/kiro` (push target: `origin`).

Legend: `[x]` done and committed, `[~]` code written but uncommitted/unverified, `[ ]` not started.

- [x] **T1** Branch `feature/kiro`, docs in `docs/kiro/`. (commit f1f5d8f3)
- [x] **T2** Rename package to `@namng108/cloudcli` 1.38.0, update all references, `npm pack --dry-run`. (commit 91c863c4)
- [~] **T3** Kiro provider id, registry, auth, API-key store, save/clear routes, tests.
- [ ] **T4** `KiroAcpClient` and runtime (stream, permissions, cancel, crash), fake ACP agent tests.
- [ ] **T5** Models/agents, sessions history, synchronizer, tests.
- [ ] **T6** MCP, skills, token usage, fork/rewind capability, tests.
- [ ] **T7** Frontend: picker, login modal with API key, MCP constants, settings, api-docs, tests.
- [~] **T8** `docker/standard/Dockerfile`, `docker-compose.yml`, docs.
- [ ] **T9** Verify (typecheck, lint, test, test:client, build), publish, Docker check, push.

Each task ends with a conventional-commit commit.

## Status notes (2026-10-29)

A parallel run of T3 and T8 was interrupted. Its output is in the working tree, uncommitted.

**T3 (in progress, unverified)**
- Present: `server/modules/providers/list/kiro/` with provider, API-key store, auth provider, and stub models, mcp, skills, sessions, session-synchronizer and runtime (the runtime throws `KIRO_RUNTIME_NOT_IMPLEMENTED`, 501).
- Present: edits to `provider.registry.ts`, `provider.routes.ts`, `server/shared/types.ts`, `database/schema.ts`, `commands.routes.ts`, and the capabilities, cli, token-usage and session-synchronizer services.
- Present: tests `kiro-api-key-store.test.ts`, `kiro-api-key-routes.test.ts`, `kiro-auth.test.ts`.
- Not yet done: run typecheck, oxlint and the new tests; confirm no regressions; commit.

**T8 (in progress, unverified)**
- Present: `docker/standard/Dockerfile`, root `docker-compose.yml`, edits to `docker/README.md` and `README.md`.
- Not yet done: confirm the `/health` endpoint, the `HOST` and `SERVER_PORT` env names and the `cloudcli start --port` flags exist in the code. Review the broad `chown` of `/usr/local/bin`. Build the image after publish (T9).

**Known environment issue**
- `better-sqlite3` is built for a different Node ABI (127 vs 137), which causes 122 pre-existing server test failures. The baseline was measured before any Kiro work. Try `npm rebuild better-sqlite3`.
- `npm run typecheck` has one pre-existing failure in `src/modules/sidebar/tests/recentConversationTitleSync.test.ts` and needs `NODE_OPTIONS=--max-old-space-size=4096`.

**Next step:** verify and commit T3 and T8, then T4 to T7, then T9.
