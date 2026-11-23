#!/usr/bin/env bash
# The ssh-agent image has its own version, a counter in docker/ssh-agent/version.json,
# separate from the app's. It changes rarely: only when something that goes into the
# image changes. This script keeps the counter honest.
#
#   scripts/release/ssh-agent-version.sh print    the counter (the image tag)
#   scripts/release/ssh-agent-version.sh check    fail if the image's files changed since the counter was bumped
#   scripts/release/ssh-agent-version.sh bump     add 1 to the counter and record the files' current state
#
# version.json also stores a hash of every file the image is built from. `check` (run in
# CI) compares it with the files, so a change to the agent, or to the two server files it
# shares with the app, cannot be released without a new counter value.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILE="$ROOT/docker/ssh-agent/version.json"

# Exactly what docker/ssh-agent/Dockerfile copies, plus the Dockerfile and its ignore file.
INPUTS=(
  docker/ssh-agent/Dockerfile
  docker/ssh-agent/Dockerfile.dockerignore
  docker/ssh-agent/entrypoint.sh
  docker/ssh-agent/service.mjs
  docker/ssh-agent/rotate-key
  server/modules/ssh-keys/ssh-key-core.ts
  server/modules/ssh-keys/ssh-agent-proxy.ts
)

inputs_hash() {
  cd "$ROOT"
  for file in "${INPUTS[@]}"; do
    [ -f "$file" ] || { echo "missing $file" >&2; exit 1; }
    sha256sum "$file"
  done | sha256sum | cut -d' ' -f1
}

json_field() { node -p "require('$FILE')['$1']"; }

case "${1:-}" in
  print)
    json_field version
    ;;
  check)
    recorded="$(json_field inputsSha256)"
    actual="$(inputs_hash)"
    if [ "$recorded" != "$actual" ]; then
      echo "The ssh-agent image's files changed, but its version was not bumped." >&2
      echo "Run: scripts/release/ssh-agent-version.sh bump   (and commit docker/ssh-agent/version.json)" >&2
      echo "Files: ${INPUTS[*]}" >&2
      exit 1
    fi
    echo "ssh-agent version $(json_field version): up to date."
    ;;
  bump)
    next=$(($(json_field version) + 1))
    printf '{\n  "version": %s,\n  "inputsSha256": "%s"\n}\n' "$next" "$(inputs_hash)" >"$FILE"
    echo "ssh-agent version is now $next. Commit docker/ssh-agent/version.json."
    ;;
  *)
    echo "usage: ssh-agent-version.sh print|check|bump" >&2
    exit 2
    ;;
esac
