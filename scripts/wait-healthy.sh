#!/usr/bin/env bash
# =============================================================================
# wait-healthy.sh — block until every compose container is healthy (or fail).
# Containers without a healthcheck (none in the dev chain) count as ready once
# running. Times out after 240s and dumps `ps` for diagnosis.
# =============================================================================
set -euo pipefail

DC=(docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml)
DEADLINE=$((SECONDS + 240))

while true; do
  # Health column: "healthy", "unhealthy", "starting", or "" (no healthcheck)
  UNREADY=$("${DC[@]}" ps --format '{{.Name}} {{.Health}}' | awk '$2 != "healthy" && $2 != "" {print}' | wc -l)
  TOTAL=$("${DC[@]}" ps --format '{{.Name}}' | wc -l)
  echo "containers: ${TOTAL} total, ${UNREADY} not healthy yet"
  if [ "$TOTAL" -gt 0 ] && [ "$UNREADY" -eq 0 ]; then
    echo "all containers healthy"
    exit 0
  fi
  if [ $SECONDS -ge $DEADLINE ]; then
    echo "TIMEOUT waiting for health:"
    "${DC[@]}" ps
    exit 1
  fi
  sleep 5
done
