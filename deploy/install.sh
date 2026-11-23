#!/usr/bin/env bash
# Installs or upgrades CloudCLI from this release bundle.
#
#   ./install.sh [--dir DIR] [--workspace DIR] [--no-start] [--remove-archive] [--yes]
#
# 1. Checks the bundle (SHA256SUMS) and that Docker and Docker Compose work.
# 2. Loads the images in images.tar.gz into Docker, when the bundle has them (the
#    offline bundle does; the small online one pulls them from the registry instead).
# 3. Copies the files into DIR (default ~/cloudcli). It never overwrites .env.compose
#    or docker-compose.override.yml, so running a newer bundle's installer upgrades
#    in place and keeps your settings.
# 4. Creates .env.compose on the first run and starts CloudCLI.
#
# Needs bash, Docker 20.10.9+ and Docker Compose 2.20+. Compatible with bash 4.2 (CentOS 7).

set -eo pipefail

HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
DIR="$HOME/cloudcli"
START=1
REMOVE_ARCHIVE=""
PASS=()
# Replaced on upgrade. Everything else in DIR belongs to the user.
MANAGED=(cloudcli-docker docker-compose.yml docker-compose.override.example.yml docker-compose.proxy.example.yml env.example Makefile maven-settings.stub.xml INSTALL.md install.sh)

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ -n "${2:-}" ] || die "--dir needs a directory."
      DIR="$2"
      shift 2
      ;;
    --workspace)
      [ -n "${2:-}" ] || die "--workspace needs a folder."
      PASS+=(--workspace "$2")
      shift 2
      ;;
    --no-start) START=""; shift ;;
    --remove-archive) REMOVE_ARCHIVE=1; shift ;;
    -y | --yes) PASS+=(--yes); shift ;;
    -h | --help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1." ;;
  esac
done

mkdir -p "$DIR"
DIR="$(readlink -f "$DIR")"
CLI=("$HERE/cloudcli-docker" --dir "$DIR")

# --- 1. checks ---------------------------------------------------------------
say "Checking Docker..."
"${CLI[@]}" doctor

if [ -f "$HERE/SHA256SUMS" ]; then
  say "Checking the files against SHA256SUMS (this reads the whole archive)..."
  (cd "$HERE" && sha256sum --check --quiet SHA256SUMS) || die "a file in this bundle is damaged or incomplete. Download it again."
fi

# --- 2. images ---------------------------------------------------------------
LOADED=""
if [ -f "$HERE/images.tar.gz" ]; then
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  size_kb="$(du -k "$HERE/images.tar.gz" | cut -f1)"
  # Not an error when the Docker data folder is not visible from here (a remote daemon).
  free_kb="$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [ -n "$free_kb" ] && [ "$free_kb" -lt $((size_kb * 4)) ]; then
    warn "$root has $((free_kb / 1024)) MB free; the images need roughly $((size_kb * 4 / 1024)) MB once loaded."
  fi
  say "Loading the images into Docker..."
  docker load -i "$HERE/images.tar.gz"
  LOADED=1
  if [ -n "$REMOVE_ARCHIVE" ]; then
    rm -f "$HERE/images.tar.gz"
    say "Removed images.tar.gz."
  fi
fi

# --- 3. files ----------------------------------------------------------------
if [ "$HERE" -ef "$DIR" ]; then
  say "Installing in place: $DIR"
else
  say "Installing into $DIR"
  for file in "${MANAGED[@]}"; do
    [ -f "$HERE/$file" ] || continue
    # Copy beside, then rename: a script that is running keeps its old file.
    cp "$HERE/$file" "$DIR/.$file.new"
    mv -f "$DIR/.$file.new" "$DIR/$file"
  done
fi
chmod +x "$DIR/cloudcli-docker" "$DIR/install.sh" 2>/dev/null || true

# --- 4. settings and start ---------------------------------------------------
"${CLI[@]}" "${PASS[@]}" init

if [ -z "$START" ]; then
  say ""
  say "Installed. Start it with: $DIR/cloudcli-docker up"
elif [ -n "$LOADED" ]; then
  "${CLI[@]}" up
else
  "${CLI[@]}" upgrade
fi

say ""
say "Next: cd $DIR && ./cloudcli-docker --help    (settings: $DIR/.env.compose)"
