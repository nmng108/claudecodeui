#!/usr/bin/env bash
# Builds a bundle of the deploy/ files for a release.
#
#   scripts/release/build-deploy-bundle.sh <version> <ssh-agent-version> <out-dir>
#       cloudcli-deploy.tar.gz: the files only; the images are pulled from the registry.
#   scripts/release/build-deploy-bundle.sh <version> <ssh-agent-version> <out-dir> --offline <registry>
#       cloudcli-offline-<version>-linux-amd64.tar.gz: the files plus images.tar.gz, the
#       images saved from the local Docker as <registry>/cloudcli:<version>-offline and
#       <registry>/cloudcli-ssh-agent:<ssh-agent-version> (both must exist locally).
#
# The ssh-agent image has its own version (docker/ssh-agent/version.json), so its tag is
# the same in both bundles. Both bundles contain SHA256SUMS, which install.sh checks, and
# the compose file with the image tags set (<version> or <version>-offline, and the agent's).
set -eo pipefail

USAGE="usage: build-deploy-bundle.sh <version> <ssh-agent-version> <out-dir> [--offline <registry>]"
VERSION="${1:?$USAGE}"
AGENT_VERSION="${2:?$USAGE}"
OUT="${3:?$USAGE}"
MODE="${4:-}"
REGISTRY="${5:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

case "$VERSION" in
  [0-9]*) ;;
  *) echo "version must not start with v: $VERSION" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if [ "$MODE" = "--offline" ]; then
  [ -n "$REGISTRY" ] || { echo "--offline needs the registry the local images are tagged with" >&2; exit 1; }
  NAME="cloudcli-offline-$VERSION-linux-amd64"
  IMAGE_TAG="$VERSION-offline"
else
  NAME="cloudcli-deploy"
  IMAGE_TAG="$VERSION"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$NAME"

for file in cloudcli-docker install.sh docker-compose.yml docker-compose.override.example.yml docker-compose.proxy.example.yml env.example Makefile maven-settings.stub.xml INSTALL.md; do
  case "$file" in
    maven-settings.stub.xml) cp "$ROOT/docker/maven-settings.stub.xml" "$STAGE/$NAME/$file" ;;
    *) cp "$ROOT/deploy/$file" "$STAGE/$NAME/$file" ;;
  esac
done
chmod +x "$STAGE/$NAME/cloudcli-docker" "$STAGE/$NAME/install.sh"

# The tag the compose file uses when .env.compose does not set CLOUDCLI_VERSION.
grep -q '@VERSION@' "$STAGE/$NAME/docker-compose.yml" || { echo "docker-compose.yml has no @VERSION@ to set" >&2; exit 1; }
grep -q '@SSH_AGENT_VERSION@' "$STAGE/$NAME/docker-compose.yml" || { echo "docker-compose.yml has no @SSH_AGENT_VERSION@ to set" >&2; exit 1; }
sed -i -e "s/@VERSION@/$IMAGE_TAG/g" -e "s/@SSH_AGENT_VERSION@/$AGENT_VERSION/g" "$STAGE/$NAME/docker-compose.yml"

if [ "$MODE" = "--offline" ]; then
  echo "Saving the images..."
  docker save "$REGISTRY/cloudcli:$IMAGE_TAG" "$REGISTRY/cloudcli-ssh-agent:$AGENT_VERSION" | gzip -6 >"$STAGE/$NAME/images.tar.gz"
fi

(cd "$STAGE/$NAME" && sha256sum -- * >SHA256SUMS)
# images.tar.gz is already compressed, so the outer archive only needs a light pass.
tar -C "$STAGE" -cf - "$NAME" | gzip -1 >"$OUT/$NAME.tar.gz"

# A GitHub release asset can be 2 GiB at most; fail here, with the numbers, not at upload.
LIMIT=2147483648
size="$(stat -c %s "$OUT/$NAME.tar.gz")"
if [ "$size" -ge "$LIMIT" ]; then
  echo "$NAME.tar.gz is $size bytes, over the 2 GiB limit of a release asset." >&2
  echo "Remove a language from docker/mise.toml or split the bundle (docs/releasing.md)." >&2
  exit 1
fi
(cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
echo "Built $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
