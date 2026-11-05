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
# Alpine release of the Node base image. Hosts whose libseccomp is too old to know
# the `pwritev2` syscall (e.g. CentOS 7, libseccomp 2.3.x) fail every SQLite write
# with "disk I/O error" on Alpine 3.24 (musl uses pwritev2); use 3.23 there.
ARG ALPINE_VERSION=3.24
# Static musl binary; mise picks musl or glibc builds of each tool at run time.
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise
FROM node:24-alpine${ALPINE_VERSION}

# uid/gid of the `agent` user. The bind-mounted repository and workspace keep
# the host's ownership, so these must match the host user (`id -u`, `id -g`)
# or the container cannot write to them (EACCES). 1000 is the common default.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

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
# mise: language version manager. The language list (docker/mise.toml) is part
# of the image at /etc/mise/config.toml; the runtimes themselves are NOT baked
# in. They are installed into /mise at container start by mise-sync.mjs, so
# /mise is meant to be a volume: it keeps what users and agents install
# (`mise use -g`), and a rebuild or a changed list never reinstalls everything.
# Shims on PATH make `java`, `python`, ... work in non-interactive shells
# without `mise activate`.
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
COPY mise.toml /etc/mise/config.toml
COPY shared/mise-sync.mjs /usr/local/lib/cloudcli/mise-sync.mjs
ENV MISE_DATA_DIR=/mise \
    MISE_CONFIG_DIR=/mise \
    MISE_CACHE_DIR=/mise/cache \
    MISE_YES=1 \
    PATH="/mise/shims:${PATH}"
RUN deluser node 2>/dev/null || true; \
    delgroup node 2>/dev/null || true; \
    addgroup -g "${AGENT_GID}" agent && \
    adduser -D -u "${AGENT_UID}" -G agent -h /home/agent -s /bin/bash agent && \
    mkdir -p /workspace /mise /app/node_modules /home/agent/.npm \
        /home/agent/.claude /home/agent/.kiro /home/agent/.cloudcli && \
    chown -R agent:agent /workspace /mise /app /home/agent

USER agent
WORKDIR /home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
# Pinned: the installer's default (latest) became 3.0.0, whose Alpine/musl
# archive fails its own glibc check during install ("Could not determine glibc
# version"). 2.37.1 is the release this integration was built and tested on.
ARG KIRO_CLI_VERSION=2.37.1
RUN curl -fsSL https://cli.kiro.dev/install | bash -s -- --version "${KIRO_CLI_VERSION}" && \
    kiro-cli --version

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
