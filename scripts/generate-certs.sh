#!/usr/bin/env bash
# =============================================================================
# generate-certs.sh — create a local self-signed TLS certificate for Traefik.
#
# Lets the edge terminate HTTPS locally so the whole "client → TLS → Traefik"
# path is real. Browsers will warn about the self-signed cert — that's expected
# locally; in production Traefik would use Let's Encrypt/ACME instead.
# =============================================================================
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/traefik" && pwd)/certs"
mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/local.crt" ]]; then
  echo "Certificate already exists at $CERT_DIR/local.crt — skipping."
  exit 0
fi

# SANs cover localhost and the local domain we use for routing.
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/local.key" \
  -out "$CERT_DIR/local.crt" \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:api.localhost,DNS:app.localhost,DNS:traefik.localhost,IP:127.0.0.1"

echo "Generated self-signed cert at $CERT_DIR/local.crt"
