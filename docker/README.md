<!-- Docker Hub short description (100 chars max): -->
<!-- Sandbox templates for running AI coding agents with a web & mobile IDE (Claude Code, Codex) -->

# Sandboxed coding agents with a web & mobile IDE (CloudCLI)

[Docker Sandbox](https://docs.docker.com/ai/sandboxes/) templates that add [CloudCLI](https://cloudcli.ai) on top of Claude Code and Codex. You get a full web and mobile IDE accessible from any browser on any device.

## Get started

### 1. Install the sbx CLI

Docker Sandboxes run agents in isolated microVMs. Install the `sbx` CLI:

- **macOS**: `brew install docker/tap/sbx`
- **Windows**: `winget install -h Docker.sbx`
- **Linux**: `sudo apt-get install docker-sbx`

Full instructions: [docs.docker.com/ai/sandboxes/get-started](https://docs.docker.com/ai/sandboxes/get-started/)

### 2. Store your API key

`sbx` manages credentials securely — your API key never enters the sandbox. Store it once:

```bash
sbx login
sbx secret set -g anthropic
```

### 3. Launch Claude Code

```bash
npx @namng108/cloudcli@latest sandbox ~/my-project
```

Open **http://localhost:3001**. Set a password on first visit. Start building.

### Using a different agent

Store the matching API key and pass `--agent`:

```bash
# OpenAI Codex
sbx secret set -g openai
npx @namng108/cloudcli@latest sandbox ~/my-project --agent codex
```

### Available templates

| Agent | Template |
|-------|----------|
| **Claude Code** (default) | `docker.io/cloudcliai/sandbox:claude-code` |
| OpenAI Codex | `docker.io/cloudcliai/sandbox:codex` |

These are used with `--template` when running `sbx` directly (see [Advanced usage](#advanced-usage)).

## Managing sandboxes

```bash
sbx ls                               # List all sandboxes
sbx stop my-project                  # Stop (preserves state)
sbx start my-project                 # Restart a stopped sandbox
sbx rm my-project                    # Remove everything
sbx exec my-project bash             # Open a shell inside the sandbox
```

If you install CloudCLI globally (`npm install -g @namng108/cloudcli`), you can also use:

```bash
cloudcli sandbox ls
cloudcli sandbox start my-project    # Restart and re-launch web UI
cloudcli sandbox logs my-project     # View server logs
```

## What you get

- **Chat** — Markdown rendering, code blocks, message history
- **Files** — File tree with syntax-highlighted editor
- **Git** — Diff viewer, staging, branch switching, commits
- **Shell** — Built-in terminal emulator
- **MCP** — Configure Model Context Protocol servers visually
- **Mobile** — Works on tablet and phone browsers

Your project directory is mounted bidirectionally — edits propagate in real time, both ways.

## Configuration

Set variables at creation time with `--env`:

```bash
npx @namng108/cloudcli@latest sandbox ~/my-project --env SERVER_PORT=8080
```

Or inside a running sandbox:

```bash
sbx exec my-project bash -c 'echo "export SERVER_PORT=8080" >> /etc/sandbox-persistent.sh'
```

Restart CloudCLI for changes to take effect:

```bash
sbx exec my-project bash -c 'pkill -f "server/index.js"'
sbx exec -d my-project cloudcli start --port 3001
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3001` | Web UI port |
| `HOST` | `0.0.0.0` | Bind address (must be `0.0.0.0` for `sbx ports`) |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | SQLite database location |

## Advanced usage

For branch mode, multiple workspaces, memory limits, or the terminal agent experience, use `sbx` with the template:

```bash
# Terminal agent + web UI
sbx run --template docker.io/cloudcliai/sandbox:claude-code claude ~/my-project --name my-project
sbx ports my-project --publish 3001:3001

# Branch mode (Git worktree isolation)
sbx run --template docker.io/cloudcliai/sandbox:claude-code claude ~/my-project --branch my-feature

# Multiple workspaces
sbx run --template docker.io/cloudcliai/sandbox:claude-code claude ~/project ~/shared-libs:ro

# Pass a prompt directly
sbx run --template docker.io/cloudcliai/sandbox:claude-code claude ~/my-project -- "Fix the auth bug"
```

CloudCLI auto-starts via `.bashrc` when using `sbx run`.

Full options in the [Docker Sandboxes usage guide](https://docs.docker.com/ai/sandboxes/usage/).

## Network policies

Sandboxes restrict outbound access by default. To reach host services from inside the sandbox:

```bash
sbx policy allow network localhost:11434
# Inside the sandbox: curl http://host.docker.internal:11434
```

The web UI itself doesn't need a policy — access it via `sbx ports`.

---

## Standard (non-sandbox) image

An alternative to the Docker Sandbox templates above, for hosts where the `sbx` microVM sandbox isn't available (e.g. no nested virtualization) or isn't needed. `docker/standard/Dockerfile` runs CloudCLI, Claude Code and Kiro CLI as regular processes in a single container — no hypervisor isolation, no `sbx` CLI required.

### Build & run

Build context must be `docker/` (same as the sandbox templates):

```bash
docker build -f docker/standard/Dockerfile -t cloudcli:standard docker/
docker run -d \
  -p 3001:3001 \
  -v "$(pwd)":/workspace \
  -v claude-home:/home/agent/.claude \
  -v kiro-home:/home/agent/.kiro \
  -v cloudcli-home:/home/agent/.cloudcli \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e KIRO_API_KEY=... \
  --name cloudcli-standard \
  cloudcli:standard
```

Open **http://localhost:3001**.

### docker-compose

The repo root [`docker-compose.yml`](../docker-compose.yml) builds the same image and wires up the volumes and port mapping:

```bash
docker compose up --build
```

Build args:

| Arg | Default | Description |
|-----|---------|-------------|
| `CLOUDCLI_VERSION` | `latest` | npm dist-tag or version of `@namng108/cloudcli` to install |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Override for a private/mirrored npm registry |

### API keys

No keys are baked into the image. Pass them at `docker run`/`compose up` time as environment variables (see `KIRO_API_KEY` / `ANTHROPIC_API_KEY` in `docker-compose.yml`, which default to empty via `${VAR:-}` if unset):

- `ANTHROPIC_API_KEY` — used by Claude Code.
- `KIRO_API_KEY` — used by Kiro CLI; CloudCLI also lets you paste a Kiro API key in the UI, which is stored in `~/.cloudcli/kiro-auth.json` inside the `cloudcli-home` volume instead.

### Volumes

| Volume | Container path | Purpose |
|--------|----------------|---------|
| workspace | `/workspace` | Your project files |
| `claude-home` | `/home/agent/.claude` | Claude Code sessions/config |
| `kiro-home` | `/home/agent/.kiro` | Kiro CLI sessions/config |
| `kiro-data` | `/home/agent/.local/share/kiro-cli` | Kiro CLI sign-in (browser login) and the engine it downloads on first use |
| `cloudcli-home` | `/home/agent/.cloudcli` | CloudCLI auth DB and stored API keys |
| `ssh-keys` | `/keys` in the `ssh-agent` container | The SSH private key. Not mounted in the app container (see *Git over SSH*) |
| `ssh-run` | `/run/ssh` | The ssh-agent and control sockets shared by the app and `ssh-agent` |
| `dind-data` | `/var/lib/docker` in `dind` | Images, containers and build cache of the optional private Docker daemon (see *Docker for the agents*) |
| `mise-data` | `/mise` | Language runtimes installed by mise (see below) |

### Base image: Debian (glibc), not Alpine

Both the standard and the dev image are built on `node:24-bookworm-slim`. Alpine (musl) was tried first and does not work for Kiro: the Kiro CLI v3 engine (the default) downloads a glibc-linked Node binary into `~/.local/share/kiro-cli/` that cannot start on musl, even with `gcompat` ("failed to spawn the v3 engine"). Debian also lets mise install the standard prebuilt runtimes and works on older hosts (for example CentOS 7, whose old libseccomp breaks Alpine 3.24's musl).

- `AGENT_UID` / `AGENT_GID` build arguments (default 1000) set the uid/gid of the `agent` user. Match them to the host user (`id -u`, `id -g`) when `/workspace` is a bind mount, otherwise the container cannot write to it.
- Native npm modules (`node-pty`, `better-sqlite3`, `bcrypt`) build with `build-essential` and `python3` when no prebuilt binary applies.
### Language runtimes (mise)

Both images include [mise](https://mise.jdx.dev), so agents and you can run Java, Python and other languages inside the container. The list of runtimes the app ships with is **`docker/mise.toml`**, copied into the image as `/etc/mise/config.toml` (mise's system config): Java Temurin 21 (default), 8 and 25, and the latest Python. Node.js comes from the base image; mise is told not to manage it.

**Runtimes are installed when the container starts, not when the image is built.** `docker/shared/mise-sync.mjs` runs first (before the app) and installs into `/mise`, which must be a volume (`mise-data` in `docker-compose.yml`, `dev-mise-data` in `docker-compose.dev.yml`). The first start downloads everything (about 1.5 minutes for the default set); later starts finish in milliseconds.

- **What stays when you update the app.** Rebuilding the image or changing an earlier Dockerfile step never reinstalls anything, because nothing is baked in. Edit `docker/mise.toml` and rebuild (`up --build`; the image build takes seconds) and only the added or changed tools are installed at the next start.
- **What users and agents install stays too.** `mise use -g go@1.23` writes to the user config in the volume (`/mise/config.toml`) and installs into the volume. The image's list is a separate file, so the two never overwrite each other.
- **Removing a language.** Delete it from `docker/mise.toml`: at the next start, versions the image's list installed earlier (recorded in `/mise/.managed-tools.json`) and no longer asks for are uninstalled. A version is kept if the user's config requests it. Versions that only a user installed were never recorded and are never removed. A tool listed as `latest` follows the same rule: when a newer release appears, the previous one is pruned.
- **No network.** A failed install is logged as a warning and the app still starts, just without the missing runtimes.
- **Download cache.** `/mise/cache` (about 0.5 GB for the default set) is kept in the same volume, so putting a removed tool back does not download it again. `mise cache clear` empties it.
- **Prebuilt binaries only.** mise is a static binary that detects the libc at run time. `all_compile = false` and `python.compile = false` in `mise.toml` keep it on prebuilt binaries, so no compiler toolchain is involved for the default set.
- Shims on `PATH` (`/mise/shims`) make `java`, `python`, ... work in non-interactive shells without `mise activate`. A project's own `mise.toml` or `.tool-versions` overrides the versions in its directory; pick another version for one command with `mise exec java@temurin-8 -- java -version`.
- Start over with `docker compose down -v` (removes all volumes) or `docker volume rm <project>_mise-data`.

### Kiro sign-in

Settings → Agents → Kiro → *Manage sign-in* offers two ways to authenticate:

- **Browser sign-in (device flow).** The server runs `kiro-cli login --use-device-flow` and shows a link and a one-time code. Open the link in a browser on any machine (the container needs no browser), confirm the code, and the CLI finishes the sign-in by itself. *AWS Builder ID* is the personal/free route; *Organization* signs in through IAM Identity Center with the start URL and region from your administrator. Google and GitHub social login is not available in this flow. The token is stored by Kiro CLI in `~/.local/share/kiro-cli`, which is the `kiro-data` volume.
- **API key.** Paste a key from app.kiro.dev, or set `KIRO_API_KEY`. A key takes precedence over a browser sign-in.

### Git over SSH

Settings > Git > *SSH key* shows the public key git uses for `git@host:...` and `ssh://` remotes, and creates one when none exists. Nothing is generated by itself: open the page, click *Generate SSH key*, copy the public key and add it to your account on GitHub, GitLab or Bitbucket (the page links to each).

The private key is held by a separate container, `ssh-agent` (`dev-ssh-agent` in the dev stack), not by the app. The app and the AI agents running in it reach it through a socket: they can sign in to git servers with the key, but cannot read it, remove it, or add keys of their own. Design and limits: [docs/ssh-keys.md](../docs/ssh-keys.md).

- **Where it lives.** The `ssh-keys` volume (`dev-ssh-keys`), mounted only in the `ssh-agent` container, so the key survives updates and recreation. Delete the volume and you generate and register a new key. `ssh-run` holds the two sockets; `known_hosts` is in `cloudcli-home` (`~/.cloudcli/known_hosts`).
- **Replace the key.** Not from the UI: the agents can reach the same socket. Run `docker compose exec ssh-agent rotate-key` (`dev-ssh-agent` in the dev stack), then add the new public key to your git servers.
- **Use your own key instead.** Mount it read-only into the `ssh-agent` container (the commented lines in the compose files): `~/.ssh/deploy_key:/keys/id_ed25519:ro` and its `.pub`. It is shown in Settings but never replaced from there. Keys protected by a passphrase cannot be loaded unattended.
- **Host keys.** The images set `StrictHostKeyChecking accept-new`: the first connection to a server records its host key, and a key that later changes is refused.
- **They can still use it.** An agent told to `git push` pushes as the key's owner. Use a dedicated key with limited access (a deploy key per repository), not your personal key.
- **Group id.** The sockets are group-accessible. Build the app and the `ssh-agent` image with the same `AGENT_GID` (default 1000).
- **No Docker?** Without `CLOUDCLI_SSH_CONTROL_SOCKET` the page manages `~/.ssh` (or `CLOUDCLI_SSH_DIR`) directly; there everything running as that user can read the private key.

### Docker for the agents (optional)

The images include the Docker CLI, `docker compose` and `docker buildx`, but no daemon. To let the agents build images and run containers, start the stack with the Docker-in-Docker overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.docker.yml up -d --build
# development stack:
docker compose --env-file .env.compose -f docker-compose.dev.yml -f docker-compose.dev.docker.yml up -d --build
```

This adds a `dind` (`dev-dind`) service with a **private** Docker daemon (not your host's), reached over TLS. It runs **privileged**, so anything that can run Docker commands has host-level reach through it: read [docs/docker-in-docker.md](../docs/docker-in-docker.md) first. The workspace is mounted at `/workspace` in both containers, so bind mounts work. Containers the agents publish on `8080-8089` (`DIND_PORTS`) are reachable at `http://localhost:8080`, and from the app container at `http://dind:8080`.

### Kiro CLI version
The images install Kiro CLI 2.37.1 (`KIRO_CLI_VERSION` build argument). The installer's default moves to newer major versions (it is now 3.0.0), so the version is pinned to the release this integration was tested on.

### Health & readiness

`HEALTHCHECK` polls `GET /health` on `SERVER_PORT` (default `3001`). `HOST` is fixed to `0.0.0.0` in the image so the server is reachable from outside the container; do not override it to `127.0.0.1` or port publishing will stop working.

## Development image

`docker/dev/Dockerfile` runs the **source tree** of this repository with hot reload, on a Debian (glibc) base with Node 24, native build tools, Claude Code and Kiro CLI. It does not install the published package and copies no repository files: the repository is bind-mounted at `/app`.

```bash
cp .env.compose.example .env.compose      # once: ports, API keys, workspace path
docker compose --env-file .env.compose -f docker-compose.dev.yml up --build
```

The container sets `WORKSPACES_ROOT=/workspace`, so workspaces added in the UI must be paths under `/workspace`. Compose variables live in `.env.compose`, not `.env`: the app reads a `.env` at the repository root, and the dev container sees that file through its bind mount. `.env.compose` is git-ignored; export `COMPOSE_ENV_FILES=.env.compose` to skip the `--env-file` flag. The same file also works for the standard stack (`docker compose --env-file .env.compose up --build`).

- UI with HMR: **http://localhost:5173** (Vite). API and WebSocket server: http://localhost:3001.
- `npm run server:dev-watch` (restarts the API on server changes) and `npm run client` (Vite) run under `concurrently`.
- `node_modules` lives in the `dev-node-modules` volume, built inside the container for Linux/glibc; the host's `node_modules` is shadowed and never used. `docker/dev/dev-entrypoint.mjs` runs `npm install` on the first start and whenever `package.json` or `package-lock.json` change, and restores `package-lock.json` if npm rewrote it.
- npm's download cache is the `dev-npm-cache` volume, so recreating the container (`down` then `up`) does not download packages again. A new or changed dependency is installed on top of the existing `node_modules`; only deleting the volumes (`down -v`) causes a full install.
- `HUSKY=0` is set so the `prepare` script does not change the host repository's git hooks path.
- The dev stack has its own `dev-*` volumes, so it never shares the auth DB or CLI credentials with the standard stack. Both stacks use ports 3001/5173 by default; override with `DEV_UI_PORT` / `DEV_SERVER_PORT`.

Variables for `docker-compose.dev.yml` (see `.env.compose.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_PATH` | `./` | Host folder mounted at `/workspace` for the projects you open in the UI |
| `VITE_USE_POLLING` | `false` | Set `true` if host edits do not reload the page (bind mounts from Windows/macOS may not deliver file-change events) |
| `DEV_UI_PORT` / `DEV_SERVER_PORT` | `5173` / `3001` | Host ports |
| `AGENT_UID` / `AGENT_GID` | `1000` / `1000` | uid/gid of the container user. Set to your host user's (`id -u`, `id -g`) so the container can write to the bind-mounted repository. A change needs a rebuild and fresh `dev-*` volumes |
| `CLOUDCLI_KIRO_ENGINE` | `v3` | Kiro CLI engine used by CloudCLI (`v3` or `v2`) |
| `KIRO_API_KEY`, `ANTHROPIC_API_KEY` | empty | Passed through as in the standard stack |

`tsx watch` has no polling mode, so on a bind mount that does not deliver events, restart the container to pick up server-side changes.

## Links

- [CloudCLI Cloud](https://cloudcli.ai) — fully managed, no setup required
- [Documentation](https://cloudcli.ai/docs) — full configuration guide
- [Discord](https://discord.gg/buxwujPNRE) — community support
- [GitHub](https://github.com/siteboon/claudecodeui) — source code and issues

## License

AGPL-3.0-or-later
