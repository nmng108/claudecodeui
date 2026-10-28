# Kiro Work: Task List

Requirements: `spec.md`. Design: `design.md`. Branch: `feature/kiro` (push target: `origin`).

Legend: `[x]` done and committed, `[~]` code written but uncommitted/unverified, `[ ]` not started.

- [x] **T1** Branch `feature/kiro`, docs in `docs/kiro/`. (commit f1f5d8f3)
- [x] **T2** Rename package to `@namng108/cloudcli` 1.38.0, update all references, `npm pack --dry-run`. (commit 91c863c4)
- [x] **T3** Kiro provider id, registry, auth, API-key store, save/clear routes, tests.
- [ ] **T4** `KiroAcpClient` and runtime (stream, permissions, cancel, crash), fake ACP agent tests.
- [ ] **T5** Models/agents, sessions history, synchronizer, tests.
- [ ] **T6** MCP, skills, token usage, fork/rewind capability, tests.
- [ ] **T7** Frontend: picker, login modal with API key, MCP constants, settings, api-docs, tests.
- [~] **T8** `docker/standard/Dockerfile`, `docker-compose.yml`, docs.
- [ ] **T9** Verify (typecheck, lint, test, test:client, build), publish, Docker check, push.

Each task ends with a conventional-commit commit.

## Status notes (2026-10-29)

A parallel run of T3 and T8 was interrupted. Its output is in the working tree, uncommitted.

**T3 (done, verified, committed)**
- `server/modules/providers/list/kiro/`: provider wrapper, API-key store
  (`~/.cloudcli/kiro-auth.json`, dir 0700, file 0600, atomic temp+rename,
  length/whitespace/control-char validation, `KIRO_API_KEY` env precedence
  reported as method `environment`, key never logged or returned), auth
  provider (`credentials_file` method for the stored-key case, matching the
  other providers' naming), and stub models/mcp/skills/sessions/
  session-synchronizer/runtime (runtime throws `KIRO_RUNTIME_NOT_IMPLEMENTED`,
  501, until T4).
- `POST`/`DELETE /api/providers/kiro/api-key` added to `provider.routes.ts`,
  under the same `authenticateToken` middleware every other `/api/providers/*`
  route uses (applied once at mount in `server/index.ts`, not per-route).
- Registered in `provider.registry.ts`, `server/shared/types.ts`
  (`LLMProvider`), `database/schema.ts` (`provider_models` CHECK), and the
  capabilities/cli/token-usage/session-synchronizer services and
  `commands.routes.ts` model-provider list.
- Fixed during review: the auth `method` string was `api_key_file`, renamed to
  `credentials_file` to match Claude/Codex/OpenCode's existing convention for
  a locally stored credentials file (no functional/frontend dependency on the
  old string). Updated two existing tests (`provider-runtime.service.test.ts`,
  `mcp.test.ts`) that hard-coded the 4-provider list and now correctly account
  for Kiro as a 5th registry entry whose MCP adapter is still a stub.
- Checked for other hard-coded provider lists (`grep opencode server/`): the
  remaining ones are OpenCode-runtime-specific (shared sqlite db, shell spawn
  command) or the Agent-API-run allowlist, which intentionally excludes Kiro
  until its runtime exists (T4) — not missed registrations.
- `npx tsc --noEmit -p server/tsconfig.json`: 0 errors. `npx oxlint server/`:
  0 errors, 2 pre-existing warnings in untouched files. All provider tests:
  380 total, 367 pass, 13 fail — the same 13 pre-existing failures as the
  baseline (`claude-auth.test.ts` x11, `claude-runtime-hold.test.ts` x2;
  unrelated to Kiro), 0 new regressions.
- Committed: `feat(kiro): add kiro provider with API-key auth`.

**T8 (in progress, unverified, left untouched by this run)**
- Present: `docker/standard/Dockerfile`, root `docker-compose.yml`, edits to `docker/README.md` and `README.md`.
- Not yet done: confirm the `/health` endpoint, the `HOST` and `SERVER_PORT` env names and the `cloudcli start --port` flags exist in the code. Review the broad `chown` of `/usr/local/bin`. Build the image after publish (T9).

**Known environment issue**
- `better-sqlite3` is built for a different Node ABI (127 vs 137), which causes 122 pre-existing server test failures. The baseline was measured before any Kiro work. Try `npm rebuild better-sqlite3`.
- `npm run typecheck` has one pre-existing failure in `src/modules/sidebar/tests/recentConversationTitleSync.test.ts` and needs `NODE_OPTIONS=--max-old-space-size=4096`.

**Next step:** verify and commit T8, then T4 to T7, then T9.

### T4 inputs from T3
- Replace `server/modules/providers/list/kiro/kiro-runtime.provider.js` (currently throws `KIRO_RUNTIME_NOT_IMPLEMENTED`) with the real `KiroAcpClient`-backed runtime; wire it into `agent.routes.ts` / `server/index.ts` the same way Claude/Codex/Cursor/OpenCode are.
- Key resolution for spawn env: `resolveKiroApiKey()` from `server/modules/providers/list/kiro/kiro-api-key.store.ts` returns the key to inject as `KIRO_API_KEY` (env precedence already applied); never read `getKiroApiKeyState()`'s `masked` field for that purpose.
- Auth status plumbing (`KiroProviderAuth.getStatus()`) and `checkInstalled()` are final; T4/T5/T6 should not need to touch `kiro-auth.provider.ts` or `kiro-api-key.store.ts`.
- Stub files to replace in later tasks: `kiro-models.provider.ts` (T5), `kiro-mcp.provider.ts` (T6), `kiro-skills.provider.ts` (T6, roots are already correct per design and likely reusable as-is), `kiro-sessions.provider.ts` / `kiro-session-synchronizer.provider.ts` (T5).
