#!/usr/bin/env bash
# Starts the deploy files (deploy/) with the two images, the way a user does, and
# checks that both services come up and the override file is picked up.
#
#   scripts/ci/smoke-stack.sh <registry> <app-tag> <ssh-agent-tag>
#
# The compose file names its images <registry>/cloudcli:<app-tag> and
# <registry>/cloudcli-ssh-agent:<ssh-agent-tag>; for local images use any registry name,
# such as `local`, after `docker tag cloudcli:x local/cloudcli:<app-tag>`.
set -eo pipefail

REGISTRY="${1:?usage: smoke-stack.sh <registry> <app-tag> <ssh-agent-tag>}"
TAG="${2:?usage: smoke-stack.sh <registry> <app-tag> <ssh-agent-tag>}"
AGENT_TAG="${3:?usage: smoke-stack.sh <registry> <app-tag> <ssh-agent-tag>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
UID_UNDER_TEST=12345
GID_UNDER_TEST=23456

fail() { echo "FAIL: $*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- compose logs ---"
    (cd "$WORK/deploy" && ./cloudcli-docker compose logs --tail 40 2>&1) || true
  fi
  (cd "$WORK/deploy" && ./cloudcli-docker compose down -v >/dev/null 2>&1) || true
  docker run --rm --user root --entrypoint chown -v "$WORK:/w" "$REGISTRY/cloudcli:$TAG" -R "$(id -u):$(id -g)" /w >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$WORK/deploy" "$WORK/workspace"
cp -r "$ROOT"/deploy/. "$WORK/deploy/"
sed -i -e "s/@VERSION@/$TAG/g" -e "s/@SSH_AGENT_VERSION@/$AGENT_TAG/g" "$WORK/deploy/docker-compose.yml"
docker run --rm --user root --entrypoint chown -v "$WORK/workspace:/w" "$REGISTRY/cloudcli:$TAG" "$UID_UNDER_TEST:$GID_UNDER_TEST" /w

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
cat >"$WORK/deploy/docker-compose.override.yml" <<YAML
services:
  cloudcli:
    environment:
      CLOUDCLI_MISE_SYNC: "0"
YAML

cd "$WORK/deploy"
# A switchable proxy file, loaded through CLOUDCLI_FILES for every command.
cp docker-compose.proxy.example.yml compose.proxy.yaml
sed -i 's#http://proxy.example.com:3128#http://smoke-proxy.invalid:3128#g' compose.proxy.yaml
# init derives the ids from the workspace folder's owner.
CLOUDCLI_REGISTRY="$REGISTRY" ./cloudcli-docker --yes --workspace "$WORK/workspace" init
grep -q "^AGENT_UID=$UID_UNDER_TEST$" .env.compose || fail "init did not take the workspace owner's uid"
{ echo "CLOUDCLI_REGISTRY=$REGISTRY"; echo "CLOUDCLI_PORT=$port"; } >>.env.compose

export CLOUDCLI_FILES=compose.proxy.yaml
./cloudcli-docker up

echo "Waiting for both services to become healthy..."
for _ in $(seq 1 60); do
  unhealthy="$(./cloudcli-docker compose ps --format '{{.Service}} {{.Health}}' | grep -v ' healthy$' || true)"
  [ -z "$unhealthy" ] && break
  sleep 3
done
[ -z "$unhealthy" ] || fail "not healthy: $unhealthy"

# From inside the container: the Docker host may be another machine (a remote daemon).
./cloudcli-docker compose exec -T cloudcli curl -fsS http://127.0.0.1:3001/health >/dev/null || fail "/health does not answer"
# shellcheck disable=SC2016
./cloudcli-docker compose exec -T cloudcli sh -c 'test "$HTTPS_PROXY" = http://smoke-proxy.invalid:3128' || fail "the proxy file was not applied"
# The ssh-agent sockets must be reachable by the remapped agent user (group AGENT_GID).
./cloudcli-docker compose exec -T -u agent cloudcli sh -c 'test -S /run/ssh/agent.sock && { ssh-add -l >/dev/null; [ $? -le 1 ]; }' || fail "the agent user cannot reach the ssh-agent socket"
./cloudcli-docker compose exec -T -u agent cloudcli sh -c 'touch /workspace/.smoke && rm /workspace/.smoke' || fail "agent cannot write to /workspace"

echo "OK: stack with $REGISTRY/cloudcli:$TAG and cloudcli-ssh-agent:$AGENT_TAG"
