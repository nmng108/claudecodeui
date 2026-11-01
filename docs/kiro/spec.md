# Kiro Provider, Package Rename and Standard Docker Image: Spec

## Goals

1. Add **Kiro** as a fifth provider (beside Claude, Codex, Cursor, OpenCode) with API-key login.
2. Publish the package as `@namng108/cloudcli` (npmjs.org, version `1.38.0`, tag `latest`, public access).
3. Add a standard (non-sandbox) Docker image on `node:24-alpine3.24` with Claude Code and Kiro CLI preinstalled, plus a `docker-compose.yml`. CloudCLI is installed from the published package.

## Requirements

### R1 Kiro provider (full parity)
- R1.1 Chat via `kiro-cli acp` (Agent Client Protocol over stdio, newline-delimited JSON) using `@agentclientprotocol/sdk`.
- R1.2 Streaming of `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`.
- R1.3 Permission prompts (`session/request_permission`) routed through the existing permission UI.
- R1.4 Cancel via the `session/cancel` notification.
- R1.5 Session list, sidebar presence and history come from Kiro's on-disk files under `~/.kiro/sessions` (file-based synchronizer and history reader), not from ACP `session/list`. Resume still uses ACP `session/load`. Kiro sessions appear under their project in the Projects sidebar beside other providers' sessions.
- R1.6 Models and agents (modes) are taken from the `session/new` response (`models.availableModels`, `models.currentModelId`), cached, with a static fallback when `kiro-cli` or the API key is unavailable. The active model of an existing session comes from its `session.json`.
- R1.7 MCP config read/write, skills discovery, token/context usage from `_kiro.dev/metadata`.
- R1.8 Fork/rewind only where ACP supports it; otherwise reported as unsupported.
- R1.9 Reasoning level: Kiro advertises effort levels `low, medium, high, xhigh, max`. The Model library shows "Reasoning level" for custom Kiro models, create and update validate against those levels, the composer offers Reasoning for models that declare levels, and the runtime applies the chosen level before the prompt.
- R1.10 Sidebar rules: Kiro sessions whose `createdReason` is `rewind` or that have a `parentSessionId` (rewind or fork children) and subagent stubs are hidden. Paths are matched to projects case-insensitively on Windows so no duplicate project appears.
- R1.11 Deleting a Kiro session in CloudCLI deletes its session directory on disk (and its entry in the Kiro `.index` cache), so it also disappears from Kiro and kiro-ui. Safeguards: the target must be inside `~/.kiro/sessions/<hash>/` and match the session id pattern, a held `.lock` or a running session refuses the delete, and `dashboard-search.db*` is never touched.

### R2 API-key login
- R2.1 The key is pasted in the UI and saved to `~/.cloudcli/kiro-auth.json` with mode 0600 (atomic write).
- R2.2 The server injects it as `KIRO_API_KEY` when spawning `kiro-cli acp`.
- R2.3 A pre-set `KIRO_API_KEY` env var takes precedence and is reported as method `environment`.
- R2.4 The key is never logged or returned to the client. Only a masked form and the method are exposed.
- R2.5 `POST` and `DELETE /api/providers/kiro/api-key` save and clear the stored key.

### R3 Package
- R3.1 `name` is `@namng108/cloudcli`, `version` is `1.38.0`, `publishConfig.access` is `public`.
- R3.2 Every in-repo reference to `@cloudcli-ai/cloudcli` is updated, except upstream repository URLs and `redirect-package`.

### R4 Docker
- R4.1 `docker/standard/Dockerfile` based on `node:24-alpine3.24`.
- R4.2 Installs Claude Code and Kiro CLI (musl build verified) before installing `@namng108/cloudcli` with retry flags.
- R4.3 Non-root user, `/workspace` volume, port 3001, healthcheck, reachable from outside the container.
- R4.4 `docker-compose.yml` with volumes for `/workspace`, `~/.claude`, `~/.kiro`, `~/.cloudcli` and env passthrough for `KIRO_API_KEY` and `ANTHROPIC_API_KEY`. No secrets in files.
- R4.5 Documented as an alternative to the Docker sandbox templates.

## Acceptance criteria
- AC1 `GET` provider auth status for `kiro` reports not installed, unauthenticated, authenticated by file, and authenticated by environment correctly.
- AC2 With a fake ACP agent, a prompt streams text and tool calls, a permission round trip completes, cancel and crash are handled.
- AC3 Kiro sessions list and reopen with history.
- AC4 `npm run typecheck`, `lint`, `test`, `test:client` and `build` pass.
- AC5 `npm pack --dry-run` shows `@namng108/cloudcli@1.38.0`.
- AC6 `npm view @namng108/cloudcli version` returns `1.38.0` after publish.
- AC7 The Docker image builds (when Docker is available) and `kiro-cli`, `claude` and `cloudcli` run `--version`.
- AC8 `feature/kiro` is pushed to `origin` without force.

## Out of scope
- Kiro OAuth/browser login. Changes to the existing sandbox Dockerfiles beyond the package name.
