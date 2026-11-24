#!/usr/bin/env bash
# Starts the app image and checks that it works, including the runtime user remap.
#
#   scripts/ci/smoke-image.sh <image> [expected-version]
#
# Used by CI before anything is published, and runnable locally. The language
# runtimes are not installed (CLOUDCLI_MISE_SYNC=0): that is a download of minutes.
set -eo pipefail

IMAGE="${1:?usage: smoke-image.sh <image> [expected-version]}"
EXPECTED_VERSION="${2:-}"
# Not 1000 (the image's own ids), so the entrypoint has to change the user.
TEST_UID=12345
TEST_GID=23456
NAME="cloudcli-smoke-$$"
WORKSPACE="$(mktemp -d)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs ---"
    docker logs "$NAME" 2>&1 | tail -n 60 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # The folder may now belong to TEST_UID; give it back before deleting.
  docker run --rm --user root --entrypoint chown -v "$WORKSPACE:/w" "$IMAGE" -R "$(id -u):$(id -g)" /w >/dev/null 2>&1 || true
  rm -rf "$WORKSPACE"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The workspace belongs to TEST_UID:TEST_GID, as a host user's folder would.
docker run --rm --user root --entrypoint chown -v "$WORKSPACE:/w" "$IMAGE" "$TEST_UID:$TEST_GID" /w

docker run -d --name "$NAME" \
  -e CLOUDCLI_MISE_SYNC=0 -e "AGENT_UID=$TEST_UID" -e "AGENT_GID=$TEST_GID" \
  -v "$WORKSPACE:/workspace" "$IMAGE" >/dev/null

echo "Waiting for the container to become healthy..."
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME")"
  case "$state" in
    "running healthy") break ;;
    "exited"* | "dead"*) fail "the container stopped: $state" ;;
  esac
  sleep 3
done
[ "$state" = "running healthy" ] || fail "not healthy after 3 minutes (state: $state)"

# From inside the container: the Docker host may be another machine (a remote daemon).
docker exec "$NAME" curl -fsS http://127.0.0.1:3001/health >/dev/null || fail "/health does not answer"

ids="$(docker exec "$NAME" sh -c 'echo "$(id -u agent):$(id -g agent)"')"
[ "$ids" = "$TEST_UID:$TEST_GID" ] || fail "agent has ids $ids, expected $TEST_UID:$TEST_GID"

# Only tini (PID 1) stays root; every node process of the app must have dropped it.
root_procs="$(docker exec "$NAME" sh -c "ps -eo uid=,pid=,comm=,args= | awk '\$1 == 0 && (\$3 == \"node\" || \$3 ~ /cloudcli|mise/)'")"
[ -z "$root_procs" ] || fail "root is still running: $root_procs"

docker exec -u agent "$NAME" sh -c 'touch /workspace/.smoke && rm /workspace/.smoke' || fail "agent cannot write to /workspace"

version="$(docker exec -u agent "$NAME" cloudcli --version | tr -d '\r')"
echo "cloudcli: $version"
if [ -n "$EXPECTED_VERSION" ]; then
  case "$version" in
    *"$EXPECTED_VERSION"*) ;;
    *) fail "cloudcli reports '$version', expected $EXPECTED_VERSION" ;;
  esac
fi
docker exec -u agent "$NAME" claude --version
docker exec -u agent "$NAME" kiro-cli --version

echo "OK: $IMAGE"
