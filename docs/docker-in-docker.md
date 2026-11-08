# Docker for the agents (Docker-in-Docker)

## Requirement

An agent working in the app container should be able to build images, run containers and use
`docker compose`, to develop and test containerized apps or start the services a project needs.

## Design

```
 app container (agent user, AI agents)          dind container (own network with the app)
 ┌───────────────────────────────┐   TLS 2376   ┌────────────────────────────────┐
 │ docker, docker compose, buildx│─────────────▶ dockerd (rootless by default)  │
 │ DOCKER_HOST=tcp://dind:2376   │              │ images, containers, volumes    │
 │ no daemon, no host socket     │              │ (dind-rootless-data volume)    │
 └───────────────────────────────┘              └────────────────────────────────┘
        both mount the workspace at /workspace
```

- The images contain the **Docker CLI**, `docker compose` and `docker buildx` (copied from the
  official `docker:<major>-cli` image; `DOCKER_VERSION` build argument, default 29). There is
  no daemon in them. Without a docker profile, `docker` reports that it cannot connect.
- The daemon is a separate service in the same compose file, behind a **profile**, so the
  default stacks start without it:

  | Profile | Service | Image | Use |
  |---|---|---|---|
  | `docker` | `dind` (`dev-dind`) | `docker:29-dind-rootless` | Recommended. Runs without `privileged`. |
  | `docker-privileged` | `dind-privileged` (`dev-dind-privileged`) | `docker:29-dind` | Fallback for hosts where the rootless daemon does not start. |

  ```sh
  docker compose --profile docker up -d
  docker compose --env-file .env.compose -f docker-compose.dev.yml --profile docker up -d
  ```

  With the development stack, make up-d-docker / make down-docker do this for you (and make up-docker runs in the foreground). **They start the privileged daemon by default**; add DIND_PROFILE=docker for the rootless one, e.g. make up-d-docker DIND_PROFILE=docker. make down-docker removes the daemon whichever profile started it.

  Enable one profile at a time. Both answer to the network alias `dind`, which is what
  `DOCKER_HOST` points at; the app starts without either (`depends_on` is `required: false`).
- The app talks to it over TCP with **mutual TLS**. The daemon generates the certificates;
  the app mounts only the client certificate (`dind-certs-client`), read-only. The server
  certificate lists the name `dind`, so the connection verifies. The CA key is not kept: a
  recreated daemon creates new certificates.
- It is a **private daemon**, not your host's. The host's `/var/run/docker.sock` is not
  mounted anywhere. Images, containers and build cache are in the daemon's data volume, so
  they survive restarts; removing the volume resets the daemon.
- **Own network.** The app and the daemon share a network (`dockernet`) that no other service
  joins, so containers an agent starts cannot reach the other containers of the compose
  project (the other stack, the ssh-agent). They can reach the app on that network (its API
  needs a token). They have normal outbound access.
- **Bind mounts work.** The workspace is mounted at the same path (`/workspace`) in both
  containers, so `docker run -v /workspace/app:/app ...` and compose files with `./src:/app`
  run by an agent find their files. Paths outside the workspace (for example `/app` in the dev
  stack, or `$HOME`) exist only in the app container; the daemon does not see them.
- **Ports.** Containers an agent starts with `-p 8080:80` are published by the daemon.
  - From the app container (and the agents): `http://dind:8080`.
  - From your machine: the daemon service publishes `DIND_PORTS` (default `7080-7089`) **on
    localhost only** (`127.0.0.1`), so `http://localhost:8080` works and other machines on the
    network cannot reach it. A port already used on your host makes the service fail to start;
    change the range in `.env.compose`.
- **Limits.** The daemon container has a memory limit (`DIND_MEMORY`, default 6g) and a process
  limit (`DIND_PIDS`, default 4096). Disk use of the data volume is not limited.
- The app waits for the daemon to be healthy before it starts, if a profile is enabled.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DIND_PORTS` | `7080-7089` | Host port range published (on localhost) by the daemon container. |
| `DIND_MEMORY` | `6g` | Memory limit of the daemon container, and so of everything it runs. |
| `DIND_PIDS` | `4096` | Process limit of the daemon container. |
| `DIND_IMAGE` | `docker:29-dind-rootless` | Rootless daemon image. Keep its major version equal to the CLI's (`DOCKER_VERSION` build argument, default 29). |
| `DIND_PRIVILEGED_IMAGE` | `docker:29-dind` | Privileged daemon image. |
| `WORKSPACE_PATH` | `./` | Host folder mounted at `/workspace` in both containers. |

## Rootless or privileged

**Rootless** (default). `dockerd` runs as an unprivileged user (uid 1000) in a user namespace
inside the container. The container is not `privileged` and has no added capabilities, but it
needs `seccomp=unconfined`, `apparmor=unconfined`, `systempaths=unconfined` and the
`/dev/net/tun` device, which the compose file sets. Tested with the dev stack on Docker
Desktop: images build, containers run, compose projects and published ports work.

Differences you will notice:
- **File ownership in the workspace.** Root in a nested container is uid 1000 (the rootless
  user), which is the `agent` user at the default `AGENT_UID`. Files a root container writes
  can be edited by the app. A container running as another user, say uid 1000 (`--user
  1000:1000`, many `node` or `postgres` images), is mapped to a different id (100999) and cannot
  write to directories owned by `agent`. Use `chmod`/`chown`, run that container as root, or
  mount a directory it owns. With `AGENT_UID` other than 1000 the root-written files are not
  `agent`'s either.
- Networking goes through `slirp4netns`: slower, and `--net=host` means the daemon's namespace.
- Publishing ports below 1024 may not work; some images that need real root capabilities fail;
  CPU and memory limits on nested containers depend on cgroup delegation.
- On a Linux host that restricts unprivileged user namespaces (for example recent Ubuntu with
  AppArmor) the daemon may not start. This was not tested on a native Linux host.

**Privileged** (`--profile docker-privileged`). Works wherever Docker does. See the risks
below. Files written by root containers are owned by root and cannot be edited by `agent`.

**Switching profiles:** stop the stack and empty the certificate volume before starting the other
one. For the development stack `make reset-dind-certs` does both. Without make, run `docker compose
down` with both profiles and remove the volume (`docker volume rm <project>_dind-certs-client`, or
`<project>_dev-dind-certs-client` for the dev stack). The two daemons create the certificate files
as different users, and the second one cannot overwrite them; the symptom is the daemon container
restarting with "Permission denied" on `/certs`.

## Security

Giving the agents Docker is a trade: it lets them build and run things, and it widens what a
prompt-injected or misbehaving agent can do. Common to both variants:

- **The client certificate is full control of the daemon.** Everything running in the app
  container can use it.
- **Anyone who can run containers can mount the workspace read-write**, and publish ports,
  pull and run any image, and use the network. The agent can already write the workspace; Docker
  adds file ownership problems and a way to run arbitrary images with it mounted.
- **Resource use.** The memory and process limits apply; CPU and disk are not limited. A
  runaway build can fill the Docker data volume (and so the host disk).
- **Supply chain.** Agents pull arbitrary images from registries. `docker login` stores its
  credentials in the agent's home, readable by everything running as `agent`.
- **Published ports** are bound to localhost, not to the network. Containers share the
  daemon's outbound access and the `dockernet` network with the app.
- **What the daemon cannot see:** the host's Docker, the `ssh-keys` volume, the CloudCLI
  database, and the app's environment. Only the workspace, its own data volume and the client
  certificate directory are mounted.

**Privileged variant.** The daemon container has all capabilities and all devices, with no
seccomp or AppArmor profile. A nested `docker run --privileged -v /:/host ...` therefore
gives root on the machine the Docker daemon runs on: on Linux that is the host, on Docker
Desktop it is the Docker VM, where every container and volume of your Docker (your other
projects, and the `ssh-keys` volume of the SSH sidecar) is reachable. **Enabling it undermines
the isolation the ssh-agent sidecar provides, and the container boundary in general.** This
escape is the standard technique and was not exercised here.

**Rootless variant.** A container that escapes lands as an unprivileged user without
capabilities inside the daemon container, so reaching the host takes a second escape, a kernel
exploit. `docker run --privileged` only grants capabilities inside the user namespace.
Residual risks:
- `seccomp=unconfined` leaves the full syscall surface of the host kernel reachable from the
  daemon container, which matters for kernel privilege-escalation bugs reachable through user
  namespaces; `systempaths=unconfined` unmasks `/proc` and `/sys` paths. These are what the
  rootless daemon needs, not a recommended setting for other containers.
- The `/dev/net/tun` device is exposed.
- Everything in the common list still applies.

It is a meaningful reduction, not a hard boundary. Only enable a docker profile where you trust
the agents and the content they act on, and prefer a throw-away machine or VM for untrusted work.

## Things to know

- **Nested containers run in the daemon's own network.** `localhost` inside a container the
  agent starts is that container; the app container reaches published ports at `dind:<port>`.
- **The first image pull is slow**, because the private daemon starts with no images. They are
  kept in the volume afterwards.
- The daemon images are Alpine-based. Old hosts (for example CentOS 7 with an old libseccomp)
  can fail to run recent Alpine images; set `DIND_IMAGE` / `DIND_PRIVILEGED_IMAGE` to an older
  tag if the service does not start.
