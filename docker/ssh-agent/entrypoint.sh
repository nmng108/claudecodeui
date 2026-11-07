#!/bin/sh
# Starts as root only to prepare the two volumes, then drops every privilege.
set -e

chown sshagent:agentgrp /keys /run/ssh 2>/dev/null || true
chmod 0700 /keys 2>/dev/null || true
# The app container reaches the sockets through the group (AGENT_GID).
chmod 0750 /run/ssh 2>/dev/null || true

exec setpriv --reuid=sshagent --regid=agentgrp --clear-groups \
  --inh-caps=-all --bounding-set=-all \
  node --disable-warning=ExperimentalWarning /opt/ssh-agent/service.mjs "${1:-serve}"