# Kiro Work: Task List

Requirements: `spec.md`. Design: `design.md`. Branch: `feature/kiro` (push target: `origin`).

Legend: `[x]` done and committed, `[~]` code written but uncommitted/unverified, `[ ]` not started.

- [x] **T1** Branch `feature/kiro`, docs in `docs/kiro/`. (commit f1f5d8f3)
- [x] **T2** Rename package to `@namng108/cloudcli` 1.38.0, update all references, `npm pack --dry-run`. (commit 91c863c4)
- [x] **T3** Kiro provider id, registry, auth, API-key store, save/clear routes, tests.
- [x] **T4** `KiroAcpClient` and runtime (stream, permissions, cancel, crash), fake ACP agent tests.
- [x] **T5** Models/agents, reasoning level, sessions history, synchronizer, tests. (reworked 2026-11-01 after GUI check, see "T5 rework" below)
  - [x] **T5a** Live Kiro model catalog from `session/new` (cache + static fallback), per-session model from `session.json`.
  - [x] **T5b** Reasoning level: Kiro effort levels in the capability matrix, runtime validate/apply, Model library shows "Reasoning level".
  - [x] **T5c** File-based session synchronizer + watcher, sidebar sessions, history reader, delete.
- [x] **T6** MCP, skills, token usage, fork/rewind capability, tests.
- [x] **T7** Frontend: picker, login modal with API key, MCP constants, settings, api-docs, tests. (commit c36378c4)
- [x] **T8** `docker/standard/Dockerfile`, `docker-compose.yml`, docs.
- [x] **T6a** Fix: tool results without content crashed the chat UI (commit 08eb451a).
- [x] **T6b** Upgrade the ACP integration to the Kiro CLI v3 engine (see the T6b section below).
- [x] **T6c** Browser end-to-end tests (Playwright), see docs/kiro/e2e.md.
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

### T5 rework (2026-11-01)

GUI check found three gaps: (1) only a "Default" Kiro model is listed, (2) the Model library has no "Reasoning level" for Kiro, (3) the Projects sidebar shows no Kiro sessions (for example `c:\users\admin\.kiro-ui\workspace` has three on disk).

Decisions: delete in CloudCLI DOES delete Kiro's session files on disk (guarded, see `design.md`); rewind and fork children and subagent stubs are hidden; Kiro reasoning levels are `low, medium, high, xhigh, max`. Out of scope this round: `npm publish`, T6, T9. Commit and push `feature/kiro` to `origin`, then stop.

Replaces the T3 stubs `kiro-models.provider.ts`, `kiro-sessions.provider.ts`, `kiro-session-synchronizer.provider.ts`. The frontend placeholders listed under "T7 inputs" are superseded by the backend capability response.

**T5 results (2026-11-01)**
- T5a: `kiro-models.provider.ts` reads `models.availableModels` / `currentModelId` from a short-lived `kiro-cli acp` `session/new` and caches it (10 min, 30 s when empty, stale-while-revalidate, shared in-flight read). The runtime seeds the same cache from its own `session/new`, applies the chosen model with `session/set_model` (sent as a raw ext request, since SDK 1.9 no longer wraps it) and tells the user if Kiro rejects it. Static fallback: `auto`, `claude-sonnet-5.5`, `claude-sonnet-5`. The active model of a session comes from its `session.json`. Frontend fallback default is `auto`.
- T5b: Kiro `supportsEffort: true`, levels `low, medium, high, xhigh, max` (a ceiling; Kiro's real levels depend on the model and were not probed live because that needs a key). The Model library needed no change: `EFFORT_LEVELS` comes from the capability matrix. The runtime sends a level only when the selected model declares it, via a muted `/effort <level>` turn (the way kiro-ui does it).
- T5c: file-based synchronizer, history reader, watcher entry and guarded delete, see `design.md`. Checked against the real `~/.kiro`: workspace `c:\users\admin\.kiro-ui\workspace` reuses the existing lowercase project, and a 363-message session loads.
- **Behavior to know:** the three sessions in that workspace are one rewind chain (`cli_0e8a9031` is the original, `sess_4c480f3b` a rewind of it, `sess_c78d1a7b` a rewind of that and the newest). The agreed default hides rewind children, so only `cli_0e8a9031` shows. Set `CLOUDCLI_KIRO_SHOW_BRANCH_SESSIONS=true` to list all three.
- Deviation from the plan: Kiro's `.index/index.json` is not read or edited (it can lag and Kiro revalidates it itself), and the legacy `sessions/cli/` store is not indexed (only subagent stubs here).
- Not changed: `supportsAbort`, `supportsPermissionRequests`, `supportsImages` and `supportsFiles` are still `false` in the Kiro capability entry although the T4 runtime implements abort and permission requests. Left for T6 / a follow-up so this change stays on the three reported issues.
- Tests: server provider/agent/project suites 470 pass, 17 fail, all 17 pre-existing (13 Claude auth/hold, 4 Windows-path assumptions in agent and project tests, identical on the previous commit). Client suite: 120 files pass. Lint: 0 errors. Server typecheck clean; the one client typecheck error is the known `recentConversationTitleSync.test.ts` fixture.
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

### T6 results (2026-11-01)
- MCP: `kiro-mcp.provider.ts` reads and writes `mcpServers` in `~/.kiro/settings/mcp.json` (user) and `<workspace>/.kiro/settings/mcp.json` (project). Transports: stdio (`command`/`args`/`env`) and http (`url`/`headers`). Other top-level keys and per-server fields written by Kiro (`disabled`, `autoApprove`) are kept for servers CloudCLI does not touch. An unparseable file is never overwritten (422 `KIRO_MCP_CONFIG_INVALID`). Writes go through a temp file plus rename. The format comes from Kiro's public docs and search snippets; the docs page itself could not be fetched here, so it was not checked against a live `kiro-cli`.
- Skills: the existing `kiro-skills.provider.ts` roots (`~/.kiro/skills`, `<workspace>/.kiro/skills`, prefix `/`) work, including the symlinked skill folders in the real `~/.kiro/skills`. The Skills tab is enabled for Kiro (the `'kiro'` exclusions were removed from `ProviderSkills.tsx` and `AgentCategoryContentSection.tsx`).
- Token usage: stays `unsupported`. Kiro records only a context-usage percentage (`session_metadata` / `contextUsage` in `messages.jsonl`), not token counts, and the counter shows tokens. `supportsTokenUsage` stays false.
- Capabilities: `supportsAbort` and `supportsPermissionRequests` are now true (the T4 runtime implements both). `supportsImages` / `supportsFiles` stay false (attachments go as text tags). Fork, rewind and message editing stay unsupported (`supportsSessionForking` and `supportsMessageEditing` false); no `_kiro.dev/*` command was found for them.
- Tests: new Kiro cases in `mcp.test.ts` (including the global adder, now 5 successes) and `skills.test.ts`. Provider suite: 437 tests, 13 fail, all in the pre-existing `claude-auth` and `claude-runtime-hold` files. Server tsc clean, oxlint 0 errors, related client tests pass.

### T6a fix and T6b v3 upgrade (2026-11-01)

**Why:** the first ACP client launched `kiro-cli acp` with no engine flag, which starts the v2 server. v2 advertises empty `sessionCapabilities`, so T4 to T6 wrongly concluded that fork, rewind and usage were unsupported. The v3 server (`--agent-engine=v3`, documented in `https://kiro.dev/docs/cli/v3/acp-migration.md`) supports them. Verified against kiro-cli 2.37.0 with a real API key.

**T6a (the crash):** a `tool_call_update` without content reached the UI as a `tool_result` whose message-level `content` was undefined, and `formatToolResultContent` called `.trim()` on `JSON.stringify(undefined)`. Fixed on both sides: the runtime now emits a `tool_result` only when the tool is `completed` or `failed`, with plain-text `content` and `isError` (`kiro-tool-output.ts`), and the UI helper tolerates missing content. Regression tests on both sides.

**Facts recorded from the live v3 server:**
- Launch: `kiro-cli acp --agent-engine=v3` (auth from `KIRO_API_KEY` works as before). The v2-only flags (`--agent`, `--model`, `--effort`, trust flags) are not used. `CLOUDCLI_KIRO_ENGINE=v2` keeps the old behavior.
- `initialize` advertises `sessionCapabilities {list, close, delete, fork}` and `_meta.kiro.extensionMethods` (`_kiro/session/context`, `_kiro/session/compact`, `_kiro/session/export`, `_kiro/session/history`, workflow and memory methods). `_kiro/account/getUsage` is NOT advertised on this build.
- `session/new` returns `configOptions`: `mode`, `model`, `effortLevel` (`thought_level`), `thinking`, `autopilot`, ... Each `model` option carries `_meta.kiro` with `effortLevels`, `defaultEffortLevel`, `hasEffort` and `rateMultiplier` (credits). Model and effort are changed with `session/set_config_option` (`configId` `model` / `effortLevel`). `session/set_model` does not exist.
- Updates: `tool_call` starts as `pending`; `tool_call_update` has `in_progress` (no output) then `completed` with `rawOutput` (an object such as `{output, exitCode, message}`) and `content` blocks. `session_info_update` is dispatched on `_meta.kiro.kind`: `context_usage` (`usagePercentage`), `turn_completion` (`promptTurnSummaries[{unit:'credit', usage}]`), `display_error`, `focus_update`, `turn_end`, `pending_interaction`. The prompt response, not `turn_end`, ends a turn.
- Permissions use the standard `options[]` (`accept`, `always-accept`, `reject`, `always-reject`); the runtime still returns one-time options only.
- `session/load` replays the whole transcript as updates; the client mutes them while loading.
- `session/fork` takes the cut point in `_meta.kiro.messageId` (a top-level `messageId` is ignored and copies everything). The id is a user message's `id` in `messages.jsonl`. The copy ends after that message's turn, answer included.

**What changed**
- `kiro-acp.client.ts`: `engine` (v3 default), `--agent-engine=v3`, `getInitializeResponse`, `supportsFork`, `setConfigOption`, `forkSession`, `session_info` and `config_option_update` events, replay muted during `resumeSession`. `setModel`/`setEffort` use config options on v3 and the old paths on v2.
- `kiro-models.provider.ts`: the catalog now comes from the `model` config option, with per-model reasoning levels and the default level (v2 `models` still parsed). The Model library shows the real levels per model; `none` is added to the Kiro capability levels because some models offer it.
- `kiro-usage.ts`, runtime and token-usage service: Kiro usage is credits plus context percentage. The live stream, the transcript (`usage_summary`, `contextUsage`) and `GET token-usage` all report `{used: credits, unit: 'credit', contextPercentage}`. `TokenUsageSummary` shows credits for Kiro. `supportsTokenUsage` is now true.
- `kiro-fork.provider.ts`: forks through `session/fork`; `supportsSessionForking` is true. User messages carry `transcriptAnchorId` (the transcript line id).
- Capabilities: `supportsAbort` and `supportsPermissionRequests` true since T6.
- Fake agent fixture speaks both engines. Tests added for the client (v3), models, usage, tool output, runtime.

**Still not done / by design**
- Message editing (rewind and resend) is not offered; `/rewind` equals fork at a message in v3, so "fork from here" covers it. Editing needs a resume-through-anchor runtime path.
- The `/cost` slash command modal still labels numbers as tokens (it is built from a different server path).
- Sidebar listing, history and delete stay file-based (Kiro advises `session/list`, but that needs a running `kiro-cli`; the file reader works offline). Revisit if Kiro changes the on-disk layout.
- Persistent permission choices (`always-accept`), `_kiro/mcp/status`, `_kiro/session/compact` and context breakdown are not surfaced in the UI.