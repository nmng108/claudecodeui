# Kiro Work: Task List

Requirements: `spec.md`. Design: `design.md`. Branch: `feature/kiro` (push target: `origin`).

Legend: `[x]` done and committed, `[~]` code written but uncommitted/unverified, `[ ]` not started.

- [x] **T1** Branch `feature/kiro`, docs in `docs/kiro/`. (commit f1f5d8f3)
- [x] **T2** Rename package to `@namng108/cloudcli` 1.38.0, update all references, `npm pack --dry-run`. (commit 91c863c4)
- [x] **T3** Kiro provider id, registry, auth, API-key store, save/clear routes, tests.
- [x] **T4** `KiroAcpClient` and runtime (stream, permissions, cancel, crash), fake ACP agent tests.
- [ ] **T5** Models/agents, sessions history, synchronizer, tests.
- [ ] **T6** MCP, skills, token usage, fork/rewind capability, tests.
- [x] **T7** Frontend: picker, login modal with API key, MCP constants, settings, api-docs, tests. (commit c36378c4)
- [x] **T8** `docker/standard/Dockerfile`, `docker-compose.yml`, docs.
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

**T7 (done, verified, committed)**
- Resumed an interrupted run; most of `src/` was already edited uncommitted,
  including `src/modules/provider-auth/KiroApiKeyPanel.tsx` and
  `src/shared/ui/KiroLogo.tsx`. Reviewed the full `git diff` for every `src/`
  and `public/` file before finishing.
- `kiro` added to `LLMProvider` (`src/shared/types.ts`) and to every
  hard-coded provider list found by grepping `opencode` across `src/` and
  `public/`: chat provider state (`useChatProviderState.ts`,
  `FALLBACK_PERMISSION_MODES`, `PROVIDERS`), selection empty state
  (`ProviderSelectionEmptyState.tsx`), login modal (`ProviderLoginModal.tsx`),
  MCP constants (`src/shared/constants.ts`) and `McpServers.tsx`, agents
  settings (`AgentsSettingsTab.tsx`, `AgentSelectorSection.tsx`,
  `AgentCategoryContentSection.tsx`, `AccountContent.tsx`), permissions
  (`userSettings.ts`), logos (`LLMProviderLogo.tsx` + new `KiroLogo.tsx`),
  sidebar formatting (`sidebarProjectFormatting.ts`), onboarding
  (`AgentConnectionsStep.tsx`, `Onboarding.tsx`), skills
  (`ProviderSkills.tsx`), export (`buildTranscriptMarkdown.ts`), i18n
  (`en/chat.json`, `en/settings.json`), and `MessageComponent.tsx` /
  `CommandResultModal.tsx` / `ModelLibraryPanel.tsx` provider label maps.
- Fixed a bug found during review: the uncommitted `FALLBACK_DEFAULT_MODEL`
  fallback gave `kiro` the same default (`'default'`) as `claude`, which
  violates the existing "each provider has a distinct default model"
  invariant and failed `chatProviderModels.test.ts`. Changed Kiro's fallback
  to `'kiro-default'` (T5 will replace it with the real `session/new` catalog
  default); updated the affected assertion.
- Added `agents.kiro.apiKey.environmentKeyCannotBeCleared` and rendered it in
  `KiroApiKeyPanel` so the environment-managed state explicitly says the key
  cannot be cleared from the UI, not just that it's environment-managed.
- `KiroApiKeyPanel.tsx` (already present, reviewed as correct): password-type
  input, link to `https://app.kiro.dev`, Save (`POST`)/Clear (`DELETE`) via
  `api.providers.saveApiKey`/`deleteApiKey` (the project's authenticated
  fetch wrapper), masked current state read from `authStatus.email` (the
  generic masked-identity field `ProviderAuthStatus` already uses for every
  provider), error display, input cleared after save, and the raw key is
  never stored outside the input's local `useState` or echoed back.
- `public/api-docs.html` `PROVIDER_ORDER` (the `{ id, name }` array) and the
  `/api/agent` provider parameter docs now include Kiro.
- i18n: English strings only, added to `en/chat.json` and `en/settings.json`.
  Confirmed via `src/modules/i18n/tests/translationCoverage.test.ts` and
  `config.ts` that `fallbackLng: 'en'` covers missing keys in other locales,
  and that the only locale parity assertions are scoped to the Chinese `git`
  namespace — unaffected by these additions, so no other locale files were
  touched.
- Capability flags: Kiro's effort levels and permission modes are left
  unlisted/`['default']` respectively (commented, pending T4/T5's real
  capability matrix), matching how other providers report unsupported
  features; `ProviderSkills.tsx` and `AgentCategoryContentSection.tsx` hide
  the skills tab for `kiro` the same way they already do for `opencode`.
- Tests added: `src/modules/provider-auth/tests/KiroApiKeyPanel.test.tsx`
  (save, clear, error display, input clears after save, masked state for a
  stored key, environment-managed state hides the form and explains why,
  and an explicit assertion that the raw key never appears in the rendered
  DOM); a Kiro case in `src/shared/tests/useSelectedProvider.test.tsx`; a
  Kiro case in `src/modules/chat/tests/chatProviderModels.test.ts` for
  provider-selection coverage (default model, permission-mode fallback).
- Validation: `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` — 1
  error, the documented pre-existing failure in
  `src/modules/sidebar/tests/recentConversationTitleSync.test.ts`
  (unrelated `backgroundSessionIds` prop, not touched by T7). `npx oxlint
  src/` — 0 errors, 135 pre-existing warnings, none in touched files.
  `NODE_OPTIONS=--max-old-space-size=4096 npm run test:client` — 882/882
  passed (119 files), 0 regressions. `NODE_OPTIONS=--max-old-space-size=4096
  npm run build:client` — succeeds (plain `npm run build:client` runs out of
  heap in this environment regardless of Kiro; only pre-existing chunk-size
  warnings).
- Committed: `feat(kiro): add kiro provider to the UI` (paths under `src/`,
  `public/`, and this file only; `server/` and package files left for the
  other concurrent agent to commit).
- Backend contract gaps for later tasks: T4's runtime/model capability
  responses should populate real effort levels, permission modes and a real
  default model for `kiro` so the frontend's placeholder fallbacks
  (`kiro-default`, `['default']`, no effort levels) get superseded by actual
  `session/new` data instead of staying as guesses.

**T8 (in progress, unverified, left untouched by this run)**
- Present: `docker/standard/Dockerfile`, root `docker-compose.yml`, edits to `docker/README.md` and `README.md`.
- Not yet done: confirm the `/health` endpoint, the `HOST` and `SERVER_PORT` env names and the `cloudcli start --port` flags exist in the code. Review the broad `chown` of `/usr/local/bin`. Build the image after publish (T9).

**Known environment issue**
- `better-sqlite3` is built for a different Node ABI (127 vs 137), which causes 122 pre-existing server test failures. The baseline was measured before any Kiro work. Try `npm rebuild better-sqlite3`.
- `npm run typecheck` has one pre-existing failure in `src/modules/sidebar/tests/recentConversationTitleSync.test.ts` and needs `NODE_OPTIONS=--max-old-space-size=4096`.

**Next step:** verify and commit T8, then T4, T5, T6, then T9.

### T4 inputs from T3
- Replace `server/modules/providers/list/kiro/kiro-runtime.provider.js` (currently throws `KIRO_RUNTIME_NOT_IMPLEMENTED`) with the real `KiroAcpClient`-backed runtime; wire it into `agent.routes.ts` / `server/index.ts` the same way Claude/Codex/Cursor/OpenCode are.
- Key resolution for spawn env: `resolveKiroApiKey()` from `server/modules/providers/list/kiro/kiro-api-key.store.ts` returns the key to inject as `KIRO_API_KEY` (env precedence already applied); never read `getKiroApiKeyState()`'s `masked` field for that purpose.
- Auth status plumbing (`KiroProviderAuth.getStatus()`) and `checkInstalled()` are final; T4/T5/T6 should not need to touch `kiro-auth.provider.ts` or `kiro-api-key.store.ts`.
- Stub files to replace in later tasks: `kiro-models.provider.ts` (T5), `kiro-mcp.provider.ts` (T6), `kiro-skills.provider.ts` (T6, roots are already correct per design and likely reusable as-is), `kiro-sessions.provider.ts` / `kiro-session-synchronizer.provider.ts` (T5).

### T7 inputs for T4/T5/T6
- The frontend treats Kiro generically; it does not block on T4/T5/T6 landing.
  Once real data is available, three placeholders should be superseded rather
  than special-cased: `FALLBACK_DEFAULT_MODEL.kiro` (`'kiro-default'`) and
  `FALLBACK_PERMISSION_MODES.kiro` (`['default']`) in
  `src/modules/chat/hooks/useChatProviderState.ts`, and the absent entry in
  `FALLBACK_PROVIDER_EFFORT_VALUES` (no effort levels advertised yet) in the
  same file — all three are read through `providerCapabilities` first, so a
  real capability response from the backend overrides them automatically.
- `ProviderSkills.tsx` and `AgentCategoryContentSection.tsx` currently hide
  the Skills tab for `kiro` the same way they do for `opencode`. If T6 adds
  real skill discovery roots for Kiro, remove `'kiro'` from the
  `Exclude<SkillsProvider, 'opencode' | 'kiro'>` in `ProviderSkills.tsx` and
  from the `selectedAgent !== 'kiro'` guard in
  `AgentCategoryContentSection.tsx`.

### T4 notes (ACP facts learned, verified against real kiro-cli 2.37.0)
- `@agentclientprotocol/sdk` ^1.9.0 (`ClientSideConnection` + `ndJsonStream`) is a dependency. `npm install` also pruned unrelated extraneous entries from `package-lock.json`.
- `initialize` returns `agentCapabilities`: `loadSession: true`, `promptCapabilities {image: true, audio: false, embeddedContext: false}`, `mcpCapabilities {http: true, sse: false}`, `sessionCapabilities: {}`, `authMethods: []`, `agentInfo {name: "Kiro CLI Agent", version: "2.37.0"}`.
- `sessionCapabilities` is empty, so standard ACP `session/list`, `session/fork` and `session/resume` are NOT advertised. Session listing goes through the Kiro extension `_kiro.dev/session/list {cwd}`; resuming uses `session/load` (supported). Fork and rewind have no advertised support: T6 should report them unsupported unless a `_kiro.dev/*` command proves otherwise.
- `session/new` returns `sessionId`, `modes` (agents such as `kiro_default`, `kiro_planner`, `kiro_guide`, each with `_meta.welcomeMessage`) and `models` (`currentModelId`, `availableModels`; default `claude-sonnet-5` with an `auto` entry). The client exposes this raw response (and the `initialize` response) for T5/T6.
- Image prompts are advertised (`image: true`), but the runtime still sends attachments as `<images_input>`/`<files_input>` tags; native image content blocks are a possible follow-up.
- `kiro-cli` needs `KIRO_API_KEY` only in the child env. The runtime auto-approves permission requests under `bypassPermissions` (Agent API) and otherwise bridges them to the UI through the shared `chat.permission-response` path (deny selects the `reject_*` option).
- Abort sends `session/cancel`; the abort handler owns the aborted `complete`. Unknown `_kiro.dev/*` notifications are ignored; `metadata`, `commands/available` and `session/list_update` are forwarded as `status` events.
- Windows: `cross-spawn` replaces the child's `exit` with an `error` event for ENOENT, and the stream closes first; the client waits briefly and reports `KIRO_CLI_NOT_FOUND`.
