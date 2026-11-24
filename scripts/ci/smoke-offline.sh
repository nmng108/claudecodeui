#!/usr/bin/env bash
# Starts the offline image with no network at all and checks that the language runtimes
# are there: nothing may be downloaded at start.
#
#   scripts/ci/smoke-offline.sh <image>
set -eo pipefail

IMAGE="${1:?usage: smoke-offline.sh <image>}"
NAME="cloudcli-offline-smoke-$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs ---"
    docker logs "$NAME" 2>&1 | tail -n 60 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The runtime sync is left on: with the runtimes in the image it has nothing to download.
docker run -d --name "$NAME" --network none "$IMAGE" >/dev/null

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

if docker logs "$NAME" 2>&1 | grep -q '\[mise-sync\] WARNING'; then
  fail "mise-sync could not install something"
fi

# Every tool the image's list asks for must be installed.
docker exec -u agent "$NAME" sh -c "mise ls --json | jq -e '[.[][] | select(.installed == false)] | length == 0'" >/dev/null \
  || fail "a language in docker/mise.toml is not installed"

for command in "python --version" "java -version" "mvn -version" "kubectl version --client" "helm version --short"; do
  echo "\$ $command"
  docker exec -u agent "$NAME" sh -c "$command" || fail "'$command' does not run"
done

echo "OK: $IMAGE works without network"
