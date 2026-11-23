# Running CloudCLI with Docker

This folder runs CloudCLI from published images. You need Linux with Docker 20.10.9 or newer and Docker Compose 2.20 or newer (`docker compose version`). Nothing else: no Node, no `make`.

## Install

There are two bundles on the [latest release](https://github.com/nmng108/claudecodeui/releases/latest).

**Online** (the machine can reach `ghcr.io`): the small `cloudcli-deploy.tar.gz`.

```bash
curl -fsSL https://github.com/nmng108/claudecodeui/releases/latest/download/cloudcli-deploy.tar.gz | tar xz
cd cloudcli-deploy && ./install.sh
```

**Offline** (the machine cannot pull images): download `cloudcli-offline-<version>-linux-amd64.tar.gz` on a machine that can, copy it over, then:

```bash
tar xzf cloudcli-offline-<version>-linux-amd64.tar.gz
cd cloudcli-offline-<version>-linux-amd64 && ./install.sh
```

The offline bundle holds the images, with Python, Java 8/21/25, Maven, kubectl and helm already inside. Loading them needs roughly four times the size of `images.tar.gz` (about 8 GB), plus the downloaded archive itself free under Docker's data folder (`docker info | grep "Docker Root Dir"`). Add `--remove-archive` to delete `images.tar.gz` once it is loaded, and delete the downloaded `.tar.gz` too.

`install.sh` asks which folder holds your projects, creates `.env.compose`, and starts CloudCLI. Then open <http://localhost:3001> and set a password. Options: `--dir` (where to install, default `~/cloudcli`), `--workspace`, `--no-start`, `--yes`.

The AI services (Claude, Kiro) are not part of the bundle: the machine must still reach them, directly or through a proxy (see below).

## Everyday use

Run these in the install folder. `make up` and `./cloudcli-docker up` do the same; the script works where `make` is not installed.

| | |
|---|---|
| `./cloudcli-docker up` | start in the background |
| `./cloudcli-docker down` | stop (projects, logins and settings are kept in volumes) |
| `./cloudcli-docker logs [service]` | follow the logs (`cloudcli`, `ssh-agent`) |
| `./cloudcli-docker ps` | list the containers |
| `./cloudcli-docker shell` | open a shell in the app container |
| `./cloudcli-docker up --dind` | also start the private Docker daemon for the agents ([docs](https://github.com/nmng108/claudecodeui/blob/main/docs/docker-in-docker.md)). Pulling images for it needs network access |
| `./cloudcli-docker -f extra.yml up` | add compose files of your own (repeatable). The same files for every command: `CLOUDCLI_FILES=extra.yml` |
| `./cloudcli-docker compose <args>` | any `docker compose` command with this project's files |

## Settings

`.env.compose` (created for you, never overwritten) holds:

- `WORKSPACE_PATH`: the folder with your projects, mounted at `/workspace`.
- `AGENT_UID` / `AGENT_GID`: the user the agents run as. They must own `WORKSPACE_PATH`; the container changes its user to them at start, so no rebuild is needed. Not root. `install.sh` fills them in from the folder's owner.
- `CLOUDCLI_PORT`, `KIRO_API_KEY`, `ANTHROPIC_API_KEY`, `MAVEN_SETTINGS_PATH`.
- `CLOUDCLI_VERSION` and `CLOUDCLI_SSH_AGENT_VERSION` (both commented out): the versions of the two images. The ssh-agent image has its own, rarely changing version number.

Restart (`./cloudcli-docker up`) after editing it.

### Behind a proxy

The proxy lives in a file you switch on and off, so it is not part of the main compose file:

```bash
cp docker-compose.proxy.example.yml compose.proxy.yaml     # edit the addresses
make FILES="-f compose.proxy.yaml" up                      # proxy on
make up                                                    # proxy off
```

Every `make` target takes `FILES`. Without `make`, pass `-f compose.proxy.yaml` to `./cloudcli-docker`, or run `export CLOUDCLI_FILES=compose.proxy.yaml` once (several files: `a.yml:b.yml`) and every command uses it. Containers read the proxy when they are created, so run `up` after switching. The file also covers the optional Docker daemon (`--dind`).

### Your own certificates, mirrors and folders

Copy `docker-compose.override.example.yml` to `docker-compose.override.yml` and uncomment what you need (a certificate authority of your own, pip/npm mirrors, extra folders or ports). That file is loaded automatically and upgrades never replace it.

### Using your own registry

If the machine reaches an internal registry but not `ghcr.io`, push the two images there (`docker pull`, `docker tag`, `docker push`) and set `CLOUDCLI_REGISTRY=<registry>/<path>` in `.env.compose`. The names are `<registry>/cloudcli` and `<registry>/cloudcli-ssh-agent`.

## Upgrade

- Online: `./cloudcli-docker self-update` downloads the latest bundle's files and restarts on the new images. `./cloudcli-docker upgrade` only pulls the images that the current files name.
- Offline: extract the newer bundle anywhere and run its `./install.sh --dir <your install folder>`. Your `.env.compose` and `docker-compose.override.yml` stay as they are.

The offline image carries its languages inside the image, so a newer bundle brings newer versions. Tools you install yourself (`mise use -g ...` in a shell) stay in the `cloudcli_mise-data` volume and win over the bundled ones.

## Problems

- `permission denied` writing to `/workspace`: the folder is not owned by `AGENT_UID:AGENT_GID`. Fix with `chown -R <uid>:<gid> <folder>` or change the two values.
- `cannot talk to the Docker daemon`: add your user to the `docker` group (`sudo usermod -aG docker $USER`) and log in again.
- `docker exec` opens a root shell in the app container. Add `-u agent` (the `shell` command does).
