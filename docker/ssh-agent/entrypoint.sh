#!/bin/sh
# Starts as root only to prepare the two volumes, then drops every privilege.
set -e

# The app container reaches the sockets through the group AGENT_GID (the gid its `agent`
# user has; the deploy compose file passes the same value to both containers). Without
# it, use the group the image was built with. The gid is used as a number, so it does not
# need to exist in this image's /etc/group (the root filesystem is read-only anyway).
GID="${AGENT_GID:-$(getent group agentgrp | cut -d: -f3)}"

chown "sshagent:${GID}" /keys /run/ssh 2>/dev/null || true
chmod 0700 /keys 2>/dev/null || true
chmod 0750 /run/ssh 2>/dev/null || true

exec setpriv --reuid=sshagent --regid="${GID}" --clear-groups \
  --inh-caps=-all --bounding-set=-all \
  node --disable-warning=ExperimentalWarning /opt/ssh-agent/service.mjs "${1:-serve}"
