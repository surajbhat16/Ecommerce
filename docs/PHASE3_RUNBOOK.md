# Phase 3 — Run & Verify Runbook (the checkout Saga)

Cumulative: full Phase 1 + 2 + 3. Adds Order, Payment, Inventory services and
RabbitMQ. Run from the project root in PowerShell.

## Rebuild the whole stack (now 16 containers)

Stop any earlier phase first (they share host ports), then:

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml up --build -d
```

New containers: order-service, payment-service, inventory-service, rabbitmq,
order-db, payment-db, inventory-db.

## Wait for health

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml ps
```

RabbitMQ takes ~20s. The three saga services wait for their DB and RabbitMQ to be
healthy before starting.

## Get a token (orders are protected)

```powershell
curl.exe -sk -X POST https://api.localhost/api/auth/login -H "content-type: application/json" -d '{\"email\":\"test1@example.com\",\"password\":\"SuperSecret123!\"}'
```

Copy the accessToken. (Register first if needed.)

## DEMO 1 — Happy path (order CONFIRMED)

Place an order for BOOK-001 (plenty of stock, payment succeeds):

```powershell
curl.exe -sk -X POST https://api.localhost/api/orders -H "content-type: application/json" -H "authorization: Bearer PASTE_TOKEN" -d '{\"items\":[{\"sku\":\"BOOK-001\",\"quantity\":1}]}'
```

You get back an orderId and status PENDING (202 Accepted — the saga runs async).
Poll the order state (replace ORDER_ID):

```powershell
curl.exe -sk https://api.localhost/api/orders/ORDER_ID -H "authorization: Bearer PASTE_TOKEN"
```

Within a second or two it should progress to CONFIRMED (PENDING → AWAITING_PAYMENT
→ CONFIRMED). That's the full saga succeeding across three services.

## DEMO 2 — Compensation path (payment fails → order FAILED)

LAPTOP-001 is the configured fail-SKU: payment always declines it. Place an order
for 1 LAPTOP-001 (there are 2 in stock, so inventory reserves fine, then payment
fails and inventory is released):

```powershell
curl.exe -sk -X POST https://api.localhost/api/orders -H "content-type: application/json" -H "authorization: Bearer PASTE_TOKEN" -d '{\"items\":[{\"sku\":\"LAPTOP-001\",\"quantity\":1}]}'
```

Poll the order: it goes PENDING → AWAITING_PAYMENT → FAILED. The compensating
transaction releases the reserved stock — verify stock returned to 2 (see below).

## DEMO 3 — Rejection path (out of stock → order REJECTED)

Order more LAPTOP-001 than exist (only 2 in stock):

```powershell
curl.exe -sk -X POST https://api.localhost/api/orders -H "content-type: application/json" -H "authorization: Bearer PASTE_TOKEN" -d '{\"items\":[{\"sku\":\"LAPTOP-001\",\"quantity\":99}]}'
```

Poll the order: PENDING → REJECTED. No payment is attempted (inventory rejects
first). This is the fail-fast ordering — the cheapest-to-compensate step runs first.

## Inspect stock (proves reservation + release)

The inventory service exposes stock directly (via its debug port 3005):

```powershell
curl.exe -sk http://localhost:3005/stock
```

Watch `available` and `reserved` change as orders reserve, confirm, and release.

## RabbitMQ management UI

Open http://localhost:15672 (guest / guest). You'll see the exchange, the queues
per consumer, message rates, and the dead-letter queue. This is the visual proof
the async event flow is real.

## What "all good" looks like

- All 16 containers healthy.
- BOOK-001 order → CONFIRMED.
- LAPTOP-001 (qty 1) order → FAILED, and stock returns to 2 (compensation worked).
- LAPTOP-001 (qty 99) order → REJECTED, no payment attempted.
- RabbitMQ UI shows the exchange and queues.
