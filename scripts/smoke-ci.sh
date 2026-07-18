#!/usr/bin/env bash
# =============================================================================
# smoke-ci.sh — CI end-to-end smoke: drives the checkout saga through all
# three deterministic terminal paths and asserts the fan-out notifications.
#
# This is the integration gate: it exercises TLS edge → gateway (JWT) → order
# orchestrator → RabbitMQ → inventory/payment → compensation → notification.
# =============================================================================
set -euo pipefail

BASE="https://api.localhost"
EMAIL="ci_$(date +%s)@example.com"
PASS="SuperSecret123!"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "1) register + login"
curl -sk -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" > /dev/null
TOKEN=$(curl -sk -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | jq -r .accessToken)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "no access token"

place() {  # place <json-items> -> orderId
  curl -sk -X POST "$BASE/api/orders" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"items\":$1}" | jq -r .orderId
}
wait_status() {  # wait_status <orderId> -> terminal status
  for _ in $(seq 1 20); do
    S=$(curl -sk "$BASE/api/orders/$1" -H "authorization: Bearer $TOKEN" | jq -r .order.status)
    case "$S" in CONFIRMED|FAILED|REJECTED) echo "$S"; return 0;; esac
    sleep 1
  done
  echo "TIMEOUT"
}

echo "2) drive the three saga paths"
A=$(place '[{"sku":"BOOK-001","quantity":1}]')
B=$(place '[{"sku":"LAPTOP-001","quantity":1}]')
C=$(place '[{"sku":"LAPTOP-001","quantity":3}]')
SA=$(wait_status "$A"); SB=$(wait_status "$B"); SC=$(wait_status "$C")
echo "   $A -> $SA ; $B -> $SB ; $C -> $SC"
[ "$SA" = "CONFIRMED" ] || fail "expected CONFIRMED, got $SA"
[ "$SB" = "FAILED" ]    || fail "expected FAILED, got $SB"
[ "$SC" = "REJECTED" ]  || fail "expected REJECTED, got $SC"

echo "3) compensation restored stock"
AVAIL=$(curl -s http://localhost:3005/stock | jq -r '.stock[] | select(.sku=="LAPTOP-001") | .available')
[ "$AVAIL" = "2" ] || fail "LAPTOP-001 available=$AVAIL, expected 2 after compensation"

echo "4) fan-out notifications arrived"
sleep 2
COUNT=$(curl -s http://localhost:3006/notifications | jq -r .count)
[ "$COUNT" -ge 4 ] || fail "expected >=4 notifications, got $COUNT"

echo "SMOKE PASS: saga + compensation + fan-out verified"
