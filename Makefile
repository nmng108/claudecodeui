# Docker Compose shortcuts for the development stack.
# Shell aliases (like dcp) are not visible to make, so the command is set here.
# Override if needed, e.g. `make up DC="docker compose"`.
DC       ?= sudo docker compose
ENV_FILE ?= .env.compose
COMPOSE  := $(DC) --env-file $(ENV_FILE) -f docker-compose.dev.yml

.PHONY: up up-d down logs ps

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
