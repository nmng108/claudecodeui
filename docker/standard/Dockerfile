# Standard (non-sandbox) CloudCLI image: Claude Code + Kiro CLI + CloudCLI
# on a plain node:24-bookworm-slim (Debian, glibc) base, with no Docker-sandbox
# microVM isolation.
#
# Build context must be docker/ (same convention as docker/claude-code and
# docker/codex), e.g.:
#   docker build -f docker/standard/Dockerfile -t cloudcli:standard docker/
ARG MISE_VERSION=2026.11.0
# Docker major version of the CLI; keep it equal to the dind service's (docker-compose.docker.yml).
ARG DOCKER_VERSION=29
# Optional local package: CI passes the exact tarball it tested and publishes
# (`--build-context cloudcli-pkg=<dir holding the .tgz>`), so the image holds that
# package and not whatever the npm registry serves. Empty by default, in which
# case CLOUDCLI_VERSION is installed from the registry.
FROM scratch AS cloudcli-pkg
# Static binary; works on any libc.
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise
# The Docker CLI is a static Go binary, so the Alpine-based CLI image is only a download source.
FROM docker:${DOCKER_VERSION}-cli AS docker-cli
# Debian (glibc), not Alpine (musl): the Kiro CLI v3 engine downloads a
# glibc-linked Node binary that cannot run on musl, even with gcompat.
FROM node:24-bookworm-slim

# uid/gid of the `agent` user. Match them to the host user (`id -u`, `id -g`)
# when /workspace is a bind mount, or the container cannot write to it.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# ---------------------------------------------------------------------------
# OS packages
# ---------------------------------------------------------------------------
# - build-essential, python3: node-gyp, for native npm modules (node-pty,
#   better-sqlite3, bcrypt)
# - ripgrep: used by Claude Code and agents for search
# - jq, unzip: used by the Kiro CLI installer
# - sqlite3: for inspecting the CloudCLI/auth sqlite database
# - iproute2 (ss, ip), procps (ps, pgrep), netcat-openbsd (nc), lsof: for checking which
#   ports and processes are up, e.g. a dev server an agent started
# - tini: proper PID 1 signal handling / zombie reaping for `docker run`
# - lib* and fonts-*: shared libraries and fonts that Playwright's Chromium
#   needs (the list is Playwright's own for Debian 12), so `npm run test:e2e`
#   runs without root.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      iproute2 \
      jq \
      lsof \
      netcat-openbsd \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      sqlite3 \
      tini \
      unzip \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      fonts-liberation \
      fonts-noto-color-emoji \
      libfontconfig1 \
      libfreetype6 && \
    rm -rf /var/lib/apt/lists/*
# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code && \
    claude --version

# ---------------------------------------------------------------------------
# CloudCLI (installed as root, before creating the non-root user)
# ---------------------------------------------------------------------------
# Installed into the base image's global npm prefix while still root, so no
# ownership changes to /usr/local/* are needed at all — the non-root user
# below only ever gets its own $HOME chowned to it.
ARG CLOUDCLI_VERSION=latest
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN --mount=type=bind,from=cloudcli-pkg,target=/pkg \
    --mount=type=cache,target=/tmp/npm-cache,sharing=locked,mode=0777 \
    set -e; \
    PKG="$(ls /pkg/*.tgz 2>/dev/null | head -n 1 || true)"; \
    if [ -n "$PKG" ]; then SPEC="$PKG"; else SPEC="@namng108/cloudcli@${CLOUDCLI_VERSION}"; fi; \
    npm install -g "$SPEC" \
      --registry=${NPM_REGISTRY} \
      --cache=/tmp/npm-cache \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
      --no-audit \
      --no-fund && \
    cloudcli --version

# ---------------------------------------------------------------------------
# Non-root user
# ---------------------------------------------------------------------------
# node:24-bookworm-slim ships a `node` user at uid/gid 1000. Replace it with
# `agent` to match the naming used by docker/claude-code and docker/codex.
#
# Only /workspace and the user's own $HOME are chowned here — the global npm
# prefix (/usr/local/lib/node_modules, /usr/local/bin) stays root-owned since
# Claude Code and CloudCLI are both installed above as root. Kiro CLI is
# installed below as `agent` into a per-user npm prefix / $HOME/.local/bin,
# so no further ownership changes to shared system paths are needed.
# mise: language version manager. The language list (docker/mise.toml) is part
# of the image at /etc/mise/config.toml; the runtimes themselves are NOT baked
# in. They are installed into /mise at container start by mise-sync.mjs, so
# /mise is meant to be a volume: it keeps what users and agents install
# (`mise use -g`), and a rebuild or a changed list never reinstalls everything.
# Shims on PATH make `java`, `python`, ... work in non-interactive shells
# without `mise activate`.
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

# Docker CLI with the compose and buildx plugins. There is no daemon in this image:
# commands reach the dind service when docker-compose.docker.yml is added (DOCKER_HOST),
# and fail with "cannot connect" otherwise.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY mise.toml /etc/mise/config.toml
COPY shared/mise-sync.mjs /usr/local/lib/cloudcli/mise-sync.mjs
# Runs first, as root: gives `agent` the host's uid/gid, fixes volume ownership, drops root.
COPY shared/entrypoint.mjs /usr/local/lib/cloudcli/entrypoint.mjs
# Writes the note about this container's Docker setup into the agents' instruction files at start.
COPY shared/agent-environment.mjs /usr/local/lib/cloudcli/agent-environment.mjs
COPY shared/agent-environment/ /usr/local/lib/cloudcli/agent-environment/
# MISE_STATE_DIR is inside the /mise volume so mise's state survives a recreated container.
ENV MISE_DATA_DIR=/mise \
    MISE_CONFIG_DIR=/mise \
    MISE_CACHE_DIR=/mise/cache \
    MISE_STATE_DIR=/mise/state \
    MISE_YES=1 \
    PATH="/mise/shims:${PATH}"
# git over SSH:
# - trust a git server's host key the first time it is seen and remember it (in
#   the cloudcli-home volume), so the first clone does not stop at a prompt nobody
#   can answer. A key that later changes is still refused.
# - authenticate through the ssh-agent sidecar's socket (docker-compose*.yml), which
#   holds the private key; the key is never in this container.
RUN printf 'Host *\n    StrictHostKeyChecking accept-new\n    UserKnownHostsFile /home/agent/.cloudcli/known_hosts\n    IdentityAgent /run/ssh/agent.sock\n' > /etc/ssh/ssh_config.d/50-cloudcli.conf
RUN userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd -g "${AGENT_GID}" agent && \
    useradd -m -u "${AGENT_UID}" -g agent -d /home/agent -s /bin/bash agent && \
    mkdir -p /workspace /mise /home/agent/.claude /home/agent/.kiro /home/agent/.cloudcli \
        /home/agent/.local/share/kiro-cli /home/agent/.ssh /home/agent/.m2 \
        /home/agent/.claude-code-ui && \
    chmod 700 /home/agent/.ssh && \
    chown -R agent:agent /workspace /mise /home/agent

# ---------------------------------------------------------------------------
# Kiro CLI (official installer)
# ---------------------------------------------------------------------------
# The Kiro v3 engine needs glibc (it downloads a glibc-linked Node binary),
# which is why the base is Debian. The installer puts the binary in
# $HOME/.local/bin, which is not on PATH by default, so PATH is extended below.
# Must run as the non-root user: the installer writes under $HOME.
USER agent
WORKDIR /home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
# Pinned to the release this integration was built and tested on (the
# installer's default moves to newer major versions).
ARG KIRO_CLI_VERSION=3.4.0
RUN curl -fsSL https://cli.kiro.dev/install | bash -s -- --version "${KIRO_CLI_VERSION}" && \
    kiro-cli --version && \
    claude --version && \
    cloudcli --version

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
WORKDIR /workspace
VOLUME ["/workspace"]

# HOST/SERVER_PORT are read by server/load-env.ts and server/modules/cli;
# 0.0.0.0 is required for the service to be reachable from outside the
# container. Override SERVER_PORT via `docker run -e SERVER_PORT=...` plus a
# matching -p mapping if a different port is needed.
ENV HOST=0.0.0.0
ENV SERVER_PORT=3001

# Playwright e2e (npm run test:e2e): use the Chromium that `npx playwright install
# chromium` downloads; the image has no Google Chrome, which the config would
# otherwise default to.
ENV E2E_BROWSER_CHANNEL=""

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" || exit 1

# The container starts as root so that entrypoint.mjs can give the `agent` user the
# host's uid/gid (AGENT_UID / AGENT_GID, set by the deploy compose file) and fix the
# ownership of the data volumes; it drops to `agent` before running anything else.
# Started with `--user`, it changes nothing. `docker exec` opens a root shell: add
# `-u agent` for the app's user.
# Then agent-environment.mjs writes the agents' Docker note, mise-sync.mjs installs/prunes
# the language runtimes in /mise, and the CMD starts.
USER root
ENTRYPOINT ["tini", "--", "node", "/usr/local/lib/cloudcli/entrypoint.mjs", "--", "node", "/usr/local/lib/cloudcli/agent-environment.mjs", "--", "node", "/usr/local/lib/cloudcli/mise-sync.mjs", "--"]
CMD ["cloudcli", "start", "--port", "3001"]
