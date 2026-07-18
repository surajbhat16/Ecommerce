#!/usr/bin/env bash
# =============================================================================
# smoke-test.sh — end-to-end verification through the FULL edge path.
#
# Exercises: client → Traefik (TLS) → Gateway (routing/JWT) → Auth → Postgres.
# Uses -k because the local cert is self-signed.
# =============================================================================
set -euo pipefail

BASE="https://api.localhost"
EMAIL="user_$(date +%s)@example.com"
PASS="SuperSecret123!"

echo "1) Registering $EMAIL ..."
REG=$(curl -sk -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
echo "   -> $REG"

echo "2) Logging in ..."
LOGIN=$(curl -sk -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
echo "   -> $LOGIN"

# Extract the access token (jq if available, else grep).
if command -v jq >/dev/null 2>&1; then
  TOKEN=$(echo "$LOGIN" | jq -r '.accessToken')
else
  TOKEN=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | sed 's/.*:"//;s/"//')
fi

echo "3) Calling a PROTECTED route with the token ..."
WHOAMI=$(curl -sk "$BASE/api/secure/whoami" -H "authorization: Bearer $TOKEN")
echo "   -> $WHOAMI"

echo "4) Calling the protected route WITHOUT a token (expect 401) ..."
curl -sk -o /dev/null -w "   -> HTTP %{http_code}\n" "$BASE/api/secure/whoami"

echo ""
echo "Smoke test complete. If you saw a token and a userId, the full path works."
