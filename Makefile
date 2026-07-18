# =============================================================================
# Makefile — the single front door to the whole stack.
#
# It documents the compose-file topology AND saves you typing long `-f` chains.
# Run `make help` to see everything.
#
# COMPOSE FILE LAYERING (how multiple compose files combine):
#   BASE  = docker-compose.yml          (networks, traefik, gateway, auth)
#   DATA  = docker-compose.data.yml     (postgres)
#   DEV   = docker-compose.override.yml (host port exposure for debugging)
# Compose deep-merges them left→right; later files override earlier ones.
# =============================================================================

# The canonical file chain for local dev.
COMPOSE := docker compose \
	-f docker-compose.yml \
	-f docker-compose.data.yml \
	-f docker-compose.override.yml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

.PHONY: init
init: ## One-time setup: generate secrets + TLS certs
	@bash scripts/generate-secrets.sh
	@bash scripts/generate-certs.sh
	@echo "Init complete. Now run: make up"

.PHONY: build
build: ## Build all images (multi-stage)
	$(COMPOSE) build

.PHONY: up
up: ## Build + start the whole stack in the background
	$(COMPOSE) up --build -d
	@echo ""
	@echo "Stack is starting. Useful URLs:"
	@echo "  Traefik dashboard : http://localhost:8081/dashboard/"
	@echo "  API (via Traefik) : https://api.localhost  (self-signed cert warning is expected)"
	@echo ""
	@echo "Run 'make status' to watch health, 'make logs' to tail logs."

.PHONY: down
down: ## Stop and remove containers + networks (keeps volumes/data)
	$(COMPOSE) down

.PHONY: clean
clean: ## Stop everything AND delete volumes (wipes the database)
	$(COMPOSE) down -v

.PHONY: status
status: ## Show container status + health
	$(COMPOSE) ps

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=50

.PHONY: logs-auth
logs-auth: ## Tail just the auth service logs
	$(COMPOSE) logs -f --tail=50 auth-service

.PHONY: scale-gateway
scale-gateway: ## Scale the API gateway to 3 replicas (load-balancing demo)
	$(COMPOSE) up -d --scale api-gateway=3 --no-recreate
	@echo "Gateway scaled to 3. Traefik will round-robin across replicas."
	@echo "Run 'make demo-lb' to SEE it."

.PHONY: demo-lb
demo-lb: ## Fire 6 requests through Traefik; watch the gateway instance id change
	@echo "Each line shows which gateway replica served the request (x-served-by-gateway):"
	@for i in 1 2 3 4 5 6; do \
		curl -sk -o /dev/null -D - https://api.localhost/health/live \
			| grep -i 'x-served-by-gateway' || true; \
	done

.PHONY: demo-secrets
demo-secrets: ## Prove secrets are NOT in the container environment
	@echo "Searching auth-service env for the JWT key (should find NOTHING sensitive):"
	@$(COMPOSE) exec auth-service env | grep -i jwt || echo "  -> only *_FILE path is present, not the secret value. Good."
	@echo ""
	@echo "The secret value lives only at /run/secrets inside the container:"
	@$(COMPOSE) exec auth-service ls -l /run/secrets/

.PHONY: demo-healing
demo-healing: ## Kill auth-service and watch Docker restart it (self-healing)
	@echo "Killing auth-service..."
	@$(COMPOSE) kill auth-service || true
	@echo "Watch it come back (restart: unless-stopped). Ctrl-C to stop watching:"
	@$(COMPOSE) ps

.PHONY: smoke
smoke: ## End-to-end smoke test: register + login through Traefik
	@bash scripts/smoke-test.sh
