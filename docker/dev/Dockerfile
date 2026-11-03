# Development CloudCLI image: runs the source tree from the repository with
# hot reload, instead of installing the published npm package.
#
# The image holds only the toolchain (Node, native build tools, Claude Code,
# Kiro CLI). The repository is bind-mounted at /app at run time, and its
# dependencies live in a named volume mounted over /app/node_modules, so the
# host's node_modules (possibly Windows or macOS binaries) is never used.
#
# Build context is docker/ (no repository files are copied), e.g.:
#   docker build -f docker/dev/Dockerfile -t cloudcli:dev docker/
# Normally started through docker-compose.dev.yml at the repository root.
ARG MISE_VERSION=2026.11.0
# Static musl binary; mise picks musl or glibc builds of each tool at run time.
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise
FROM node:24-alpine3.24

# Same toolchain as docker/standard/Dockerfile, so a bug seen here is a bug in
# the shipped image too (see that file for why each package is needed).
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

# Claude Code's bundled ripgrep is glibc-linked; use the apk `rg` on musl.
ENV USE_BUILTIN_RIPGREP=0
RUN npm install -g @anthropic-ai/claude-code && \
    claude --version

# node:24-alpine ships a `node` user at uid/gid 1000; rename it to `agent` like
# the other images. /app/node_modules and ~/.npm are created here so the named
# volumes mounted over them start out owned by `agent`.
# mise: language version manager (see docker/mise.toml for the installed set).
# /mise holds its data and config; shims on PATH make `java`, `python`, ... work
# in non-interactive shells (agents, scripts) without `mise activate`.
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV MISE_DATA_DIR=/mise \
    MISE_CONFIG_DIR=/mise \
    MISE_CACHE_DIR=/mise/cache \
    MISE_YES=1 \
    PATH="/mise/shims:${PATH}"
RUN deluser node 2>/dev/null || true; \
    delgroup node 2>/dev/null || true; \
    addgroup -g 1000 agent && \
    adduser -D -u 1000 -G agent -h /home/agent -s /bin/bash agent && \
    mkdir -p /workspace /mise /app/node_modules /home/agent/.npm \
        /home/agent/.claude /home/agent/.kiro /home/agent/.cloudcli && \
    chown -R agent:agent /workspace /mise /app /home/agent

USER agent
WORKDIR /home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    kiro-cli --version

# Language runtimes from docker/mise.toml, installed as `agent` so the agent
# can add more at run time. Placed last because it is the slowest layer; it is
# rebuilt only when mise.toml changes.
COPY --chown=agent:agent mise.toml /mise/config.toml
RUN mise install && mise ls
# The bind-mounted repository is owned by the host user, not by `agent`, and
# git refuses such repositories ("dubious ownership") without this.
RUN git config --global --add safe.directory '*'

# HUSKY=0: the `prepare` script would otherwise write core.hooksPath into the
# host repository's .git/config through the bind mount.
ENV HUSKY=0
# HOST must be 0.0.0.0 for published ports to reach the Vite and API servers.
ENV HOST=0.0.0.0
ENV SERVER_PORT=3001
ENV VITE_PORT=5173

WORKDIR /app
EXPOSE 3001 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" || exit 1

# The bootstrap script lives in the repository (docker/dev/) and is therefore
# read from the bind mount: it installs dependencies when package*.json
# changed, then starts the API server (restarts on change) and Vite.
ENTRYPOINT ["tini", "--"]
CMD ["node", "docker/dev/dev-entrypoint.mjs"]
