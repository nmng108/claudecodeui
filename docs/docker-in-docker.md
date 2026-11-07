# Docker for the agents (Docker-in-Docker)

## Requirement

An agent working in the app container should be able to build images, run containers and use
`docker compose`, to develop and test containerized apps or start the services a project needs.

## Design

```
 app container (agent user, AI agents)          dind container (privileged)
 ┌───────────────────────────────┐   TLS 2376   ┌──────────────────────────────┐
 │ docker, docker compose, buildx│─────────────▶ dockerd                       │
 │ DOCKER_HOST=tcp://dind:2376   │              │ images, containers, volumes   │
 │ no daemon, no host socket     │              │ (dind-data volume)            │
 └───────────────────────────────┘              └──────────────────────────────┘
        both mount the workspace at /workspace
```

- The images contain the **Docker CLI**, `docker compose` and `docker buildx` (copied from the
  official `docker:<major>-cli` image; `DOCKER_VERSION` build argument, default 29). There is
  no daemon in them. Without the overlay below, `docker` reports that it cannot connect.
- The daemon is a separate **`dind` service** (`docker:<major>-dind`). It is optional and
  lives in an overlay compose file, so the default stacks stay unprivileged:

  | Stack | Command |
  |---|---|
  | published package | `docker compose -f docker-compose.yml -f docker-compose.docker.yml up -d --build` |
  | development | `docker compose --env-file .env.compose -f docker-compose.dev.yml -f docker-compose.dev.docker.yml up -d --build` |

  The services are `dind` and `dev-dind`.
- The app talks to it over TCP with **mutual TLS**. The daemon generates the certificates into
  the `*-dind-certs-ca` / `*-dind-certs-client` volumes; the app mounts only the client
  certificate, read-only. The server certificate lists the service name (`DOCKER_TLS_SAN`),
  so the connection verifies.
- It is a **private daemon**, not your host's. The host's `/var/run/docker.sock` is not
  mounted anywhere, and the agents cannot see or touch the host's containers. Images, containers,
  volumes and build cache are in the `*-dind-data` volume, so they survive restarts. Removing the
  volume resets the daemon.
- **Bind mounts work.** The workspace is mounted at the same path (`/workspace`) in both
  containers, so `docker run -v /workspace/app:/app ...` and compose files with `./src:/app`
  run by an agent find their files. Paths outside the workspace (for example `/app` in the dev
  stack, or `$HOME`) exist only in the app container; the daemon does not see them.
- **Ports.** Containers an agent starts with `-p 8080:80` are published by the daemon, which
  runs in the `dind` container.
  - From the app container (and the agents): `http://dind:8080` (`dev-dind` in the dev stack).
  - From your machine: the `dind` service publishes `DIND_PORTS` (default `8080-8089`) to the host,
    so `http://localhost:8080` works. Change the range in `.env.compose`; a port already used on
    your host makes the stack fail to start.
- The app waits for the daemon to be healthy (`docker info`) before it starts.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DIND_PORTS` | `8080-8089` | Host port range published by the daemon container. |
| `DIND_IMAGE` | `docker:29-dind` | The daemon image. Keep its major version equal to the CLI's (`DOCKER_VERSION` build argument, default 29). |
| `WORKSPACE_PATH` | `./` | Host folder mounted at `/workspace` in both containers. |

## Security

**The `dind` service runs with `privileged: true`.** Docker cannot run inside a container
otherwise. What that means for you:

- Whoever can run Docker commands can start a container with host-level privileges
  (`docker run --privileged ...`) **inside the `dind` container**, which is itself privileged
  on the Docker host. In practice, an agent with Docker access is not contained by the
  container boundary the way an agent without it is. Treat enabling this overlay as giving
  the agents root-equivalent access to the machine running Docker.
- It is still narrower than mounting the host socket: the agents cannot see, stop or read
  your host's containers and volumes, and a mistake (`docker system prune -a`, `docker rm -f
  $(docker ps -aq)`) only affects the private daemon.
- Only enable it where you trust the agents and the prompts they act on, and prefer a
  throw-away machine or VM for untrusted work.
- If your host supports it, `docker:<major>-dind-rootless` or the Sysbox runtime avoid the
  `privileged` flag. Neither is configured here.
- The client certificate in the app container is the credential for the daemon. Everything
  that runs there can use it.

## Things to know

- **Files created by containers are owned by the user inside them (usually root).** On the
  bind-mounted workspace that can make files hard to edit or delete from the host or by the
  agent. Run containers with `--user "$(id -u):$(id -g)"` or `user:` in compose when they
  write to `/workspace`.
- **Nested containers run in the daemon's own network.** `localhost` inside a container the
  agent starts is that container; the app container reaches published ports at `dind:<port>`.
- **The first image pull is slow**, because the private daemon starts with no images. They are
  kept in the volume afterwards.
- The `dind` image is Alpine-based. Old hosts (for example CentOS 7 with an old libseccomp)
  can fail to run recent Alpine images; set `DIND_IMAGE` to an older tag if the service does not
  start.