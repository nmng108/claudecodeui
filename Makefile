# Docker Compose shortcuts for the development stack.
# Shell aliases (like dcp) are not visible to make, so the command is set here.
# Override if docker needs sudo, e.g. `make up DC="sudo docker compose"`.
DC       ?= docker compose
ENV_FILE ?= .env.compose
COMPOSE  := $(DC) --env-file $(ENV_FILE) -f docker-compose.dev.yml

# Docker for the agents (see docs/docker-in-docker.md): the *-docker targets add a
# private Docker daemon (dind) next to the app. They start the PRIVILEGED daemon by
# default, which works on any Docker host but gives whatever can run Docker commands
# root-equivalent reach on it. Use the rootless one where it starts:
#   make up-d-docker DIND_PROFILE=docker
DIND_PROFILE ?= docker-privileged
# Every profile, so `down` also removes a daemon started with the other one.
ALL_DIND_PROFILES := --profile docker --profile docker-privileged

.PHONY: up up-d down logs ps up-docker up-d-docker down-docker reset-dind-certs

up: ## Build and start in the foreground
	$(COMPOSE) up --build

up-d: ## Build and start in the background
	$(COMPOSE) up --build -d

down: ## Stop and remove containers and networks
	$(COMPOSE) down

logs: ## Follow logs, optionally for one service: make logs SERVICE=cloudcli-dev
	$(COMPOSE) logs -f $(SERVICE)

ps: ## List containers
	$(COMPOSE) ps

up-docker: ## Like `up`, plus the Docker daemon for the agents (DIND_PROFILE=docker for rootless)
	$(COMPOSE) --profile $(DIND_PROFILE) up --build

up-d-docker: ## Like `up-d`, plus the Docker daemon for the agents (DIND_PROFILE=docker for rootless)
	$(COMPOSE) --profile $(DIND_PROFILE) up --build -d

down-docker: ## Stop and remove the stack including the Docker daemon, whichever profile started it
	$(COMPOSE) $(ALL_DIND_PROFILES) down

# The rootless and the privileged daemon create the client certificate as different
# users and cannot overwrite each other's. Run this before switching DIND_PROFILE
# (it empties the volume from a throw-away root container; the daemon recreates the files).
reset-dind-certs: down-docker ## Empty the Docker client certificate volume (needed when switching DIND_PROFILE)
	$(COMPOSE) run --rm --no-deps --user root --entrypoint sh dev-dind -c "rm -f /certs/client/*"
