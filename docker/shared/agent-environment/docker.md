# Docker in this environment

{{STATUS}}

You run inside the `cloudcli` container. `docker` (DOCKER_HOST={{DOCKER_HOST}}) talks to a private Docker daemon in a separate container named `{{DIND_HOST}}`. It is not the user's Docker. Containers you start run in that daemon, not in this container.

- `localhost` in your shell is this container. Reach a published container port at `http://{{DIND_HOST}}:<host port>`, not at `localhost`.
- The user's machine can reach only host ports {{DIND_PORTS}}, as `http://localhost:<port>` on their side. To make a service visible to the user, publish it on a port in that range, for example `-p {{FIRST_PORT}}:5500` or `"{{FIRST_PORT}}:5500"` in a compose file, and tell them the URL. A port outside that range is reachable only by you.
- A host port serves one container at a time. Run `docker ps` before choosing one.
- An app you run directly in this container (from source, a dev server) is not reachable from the user's machine, because this container publishes no port in that range. Start it listening on `0.0.0.0`, detached (`setsid nohup <cmd> > /tmp/app.log 2>&1 < /dev/null &`), then run `node {{EXPOSE_SCRIPT}} <host port> <app port>` to forward a free host port to it, and tell the user the URL. Run it with `stop` as the last argument to remove the forwarder. If your shell tool blocks `docker run`, ask the user to run the command instead of working around the block.
- Bind mounts work only for paths under `/workspace`, which the daemon mounts at the same path. Other paths, such as `$HOME`, do not exist in the daemon.
