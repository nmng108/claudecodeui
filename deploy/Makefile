# Shortcuts for ./cloudcli-docker (the script does the work and also runs without make).
#   make up                       start in the background
#   make up-docker                start, plus the Docker daemon for the agents
#   make FILES="-f a.yml" up      add compose files (every target takes FILES, so a file such
#                                 as a proxy override applies to all commands)
#   make logs SERVICE=cloudcli
CLOUDCLI ?= ./cloudcli-docker
FILES    ?=
DIND     ?= privileged

.PHONY: up down restart ps logs pull upgrade self-update shell doctor up-docker down-docker

up: ## Start in the background
	$(CLOUDCLI) $(FILES) up

down: ## Stop and remove the containers (volumes are kept)
	$(CLOUDCLI) $(FILES) down

restart: ## Down, then up
	$(CLOUDCLI) $(FILES) restart

ps: ## List containers
	$(CLOUDCLI) $(FILES) ps

logs: ## Follow logs, optionally for one service: make logs SERVICE=ssh-agent
	$(CLOUDCLI) $(FILES) logs $(SERVICE)

pull: ## Pull the images
	$(CLOUDCLI) $(FILES) pull

upgrade: ## Pull the images and restart
	$(CLOUDCLI) $(FILES) upgrade

self-update: ## Download the latest release's files, then upgrade
	$(CLOUDCLI) $(FILES) self-update

shell: ## Open a shell in the app container
	$(CLOUDCLI) $(FILES) shell

doctor: ## Check Docker and Docker Compose
	$(CLOUDCLI) doctor

up-docker: ## Start, plus the Docker daemon for the agents (DIND=rootless for the rootless one)
	$(CLOUDCLI) $(FILES) --dind=$(DIND) up

down-docker: ## Stop everything, including the Docker daemon, whichever kind started it
	$(CLOUDCLI) $(FILES) down
