#!/usr/bin/env bash
# =============================================================================
# generate-secrets.sh — create the real Docker secret files locally.
#
# Docker secrets in COMPOSE (non-Swarm) are backed by files on disk. This script
# generates strong random values into infra/secrets/*.txt. Those files are
# gitignored and mounted into containers at /run/secrets/<name> at runtime.
#
# Run once before `make up`. Idempotent: it won't clobber existing secrets.
# =============================================================================
set -euo pipefail

SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/secrets" && pwd)"

gen() {
  local file="$SECRETS_DIR/$1"
  local length="$2"
  if [[ -f "$file" ]]; then
    echo "exists, skipping: $1"
    return
  fi
  # openssl rand → base64, trimmed to desired length, no trailing newline issues.
  openssl rand -base64 48 | tr -d '\n/+=' | head -c "$length" > "$file"
  echo "generated: $1"
}

echo "Generating secrets into $SECRETS_DIR"
gen "auth_db_password.txt" 32
gen "order_db_password.txt" 32
gen "payment_db_password.txt" 32
gen "inventory_db_password.txt" 32
gen "catalog_mongo_password.txt" 32
gen "jwt_signing_key.txt" 64
echo "Done. These files are gitignored and will NOT be committed."