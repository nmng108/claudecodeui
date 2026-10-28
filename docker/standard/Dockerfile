# Standard (non-sandbox) CloudCLI image: Claude Code + Kiro CLI + CloudCLI
# on a plain node:24-alpine3.24 base, with no Docker-sandbox microVM isolation.
#
# Build context must be docker/ (same convention as docker/claude-code and
# docker/codex), e.g.:
#   docker build -f docker/standard/Dockerfile -t cloudcli:standard docker/
FROM node:24-alpine3.24

# ---------------------------------------------------------------------------
# OS packages
# ---------------------------------------------------------------------------
# - bash, curl, git, openssh-client, ca-certificates: general CLI/VCS tooling
# - build-base, python3: native module builds (node-pty, better-sqlite3, bcrypt)
# - ripgrep: system `rg` binary — Claude Code's bundled ripgrep is glibc-linked
#   and fails to load on musl, so USE_BUILTIN_RIPGREP=0 (set below) makes
#   Claude Code shell out to this package instead.
# - libgcc, libstdc++: runtime shared libs for prebuilt native addons
# - jq, sqlite: used by the Kiro installer (jq) and for inspecting the
#   CloudCLI/auth sqlite database (sqlite)
# - unzip: required by the Kiro CLI installer to unpack its release archive
# - tini: proper PID 1 signal handling / zombie reaping for `docker run`
RUN apk add --no-cache \
      bash \
      curl \
      git \
      openssh-client \
      ca-certificates \
      build-base \
      python3 \
      ripgrep \
      libgcc \
      libstdc++ \
      jq \
      sqlite \
      unzip \
      tini

# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
# USE_BUILTIN_RIPGREP=0: Claude Code ships a glibc-linked ripgrep binary that
# cannot load on musl (Alpine). This env var makes it use the `rg` binary
# from the apk package above instead. See apk comment for ripgrep.
ENV USE_BUILTIN_RIPGREP=0
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
RUN --mount=type=cache,target=/tmp/npm-cache,sharing=locked,mode=0777 \
    npm install -g @namng108/cloudcli@${CLOUDCLI_VERSION} \
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
# node:24-alpine already ships a `node` user at uid/gid 1000. Rename it to
# `agent` to match the naming used by docker/claude-code and docker/codex,
# without changing its uid/gid or home directory ownership.
#
# Only /workspace and the user's own $HOME are chowned here — the global npm
# prefix (/usr/local/lib/node_modules, /usr/local/bin) stays root-owned since
# Claude Code and CloudCLI are both installed above as root. Kiro CLI is
# installed below as `agent` into a per-user npm prefix / $HOME/.local/bin,
# so no further ownership changes to shared system paths are needed.
RUN deluser node 2>/dev/null || true; \
    delgroup node 2>/dev/null || true; \
    addgroup -g 1000 agent && \
    adduser -D -u 1000 -G agent -h /home/agent -s /bin/bash agent && \
    mkdir -p /workspace && \
    chown -R agent:agent /workspace /home/agent

# ---------------------------------------------------------------------------
# Kiro CLI (official installer, musl build auto-detected)
# ---------------------------------------------------------------------------
# The installer at https://cli.kiro.dev/install detects musl libc (via
# /lib/libc.musl-*.so.1 and `ldd` output) and downloads the
# kirocli-<arch>-linux-musl.zip release automatically — no glibc shim
# (gcompat) is required on this base image. It installs to
# $HOME/.local/bin, which is not on PATH by default, so PATH is extended
# below. Must run as the non-root user: the installer writes under $HOME.
USER agent
WORKDIR /home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
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

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["cloudcli", "start", "--port", "3001"]
