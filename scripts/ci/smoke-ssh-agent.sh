#!/usr/bin/env bash
# Starts the ssh-agent image the way docker-compose does (read-only, no network, few
# capabilities) with a group id other than the built-in one, and checks that it comes up
# and that its sockets belong to that group.
#
#   scripts/ci/smoke-ssh-agent.sh <image>
set -eo pipefail

IMAGE="${1:?usage: smoke-ssh-agent.sh <image>}"
GID=23456
NAME="cloudcli-ssh-agent-smoke-$$"
KEYS="$NAME-keys"
RUN="$NAME-run"

fail() { echo "FAIL: $*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs ---"
    docker logs "$NAME" 2>&1 | tail -n 40 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$KEYS" "$RUN" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker volume create "$KEYS" >/dev/null
docker volume create "$RUN" >/dev/null
docker run -d --name "$NAME" --read-only --tmpfs /tmp --network none --init \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add KILL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true -e "AGENT_GID=$GID" \
  -v "$KEYS:/keys" -v "$RUN:/run/ssh" "$IMAGE" >/dev/null

echo "Waiting for the agent..."
for _ in $(seq 1 30); do
  if docker exec "$NAME" /opt/ssh-agent/entrypoint.sh health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ -n "$healthy" ] || fail "the agent did not become healthy"

listing="$(docker run --rm --user root --entrypoint ls -v "$RUN:/run/ssh" "$IMAGE" -ln /run/ssh)"
echo "$listing"
echo "$listing" | grep -q "agent.sock" || fail "no agent socket"
echo "$listing" | grep -E 'agent.sock|control.sock' | awk -v gid="$GID" '$4 != gid { bad = 1 } END { exit bad }' \
  || fail "a socket does not belong to group $GID"

echo "OK: $IMAGE"
