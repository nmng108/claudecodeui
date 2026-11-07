# ssh-agent sidecar: holds the SSH private key, away from the app and the agents.
# Build context is the repository root (it shares server/modules/ssh-keys/ssh-key-core.ts
# with the app); docker/ssh-agent/Dockerfile.dockerignore keeps the context small.
#   docker build -f docker/ssh-agent/Dockerfile -t cloudcli-ssh-agent .
#
# Debian (glibc) like the app images, so it runs wherever they do.
FROM node:24-bookworm-slim

# Group id of the app's `agent` user. The sockets are group-accessible, so the app
# container (running as that group) can reach them and nothing else can.
ARG AGENT_GID=1000

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && (userdel -r node 2>/dev/null || true) \
    && (groupdel node 2>/dev/null || true) \
    && groupadd -g "${AGENT_GID}" agentgrp \
    && useradd -u 10001 -g agentgrp -M -d /nonexistent -s /usr/sbin/nologin sshagent \
    && mkdir -p /opt/ssh-agent /keys /run/ssh \
    && chown sshagent:agentgrp /keys /run/ssh

COPY docker/ssh-agent/service.mjs docker/ssh-agent/entrypoint.sh /opt/ssh-agent/
COPY server/modules/ssh-keys/ssh-key-core.ts server/modules/ssh-keys/ssh-agent-proxy.ts /opt/ssh-agent/
COPY docker/ssh-agent/rotate-key /usr/local/bin/rotate-key
RUN chmod 0755 /opt/ssh-agent/entrypoint.sh /usr/local/bin/rotate-key

# /keys holds the private key (only this container mounts it); /run/ssh holds the
# two sockets and is shared with the app container.
VOLUME ["/keys", "/run/ssh"]

ENTRYPOINT ["/opt/ssh-agent/entrypoint.sh"]
CMD ["serve"]