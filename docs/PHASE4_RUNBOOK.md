# Phase 4 — Run & Verify Runbook (event fan-out / notifications)

Cumulative: full Phase 1 + 2 + 3 + 4. Adds ONE container: `notification-service`
(no new database — it's a pure consumer). Run from the project root in PowerShell.

## Rebuild the stack (now 16 containers)

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml up --build -d
```

Only `notification-service` is new; `order-service` is rebuilt (its
`order.created` event now carries `userId`). If a file edit doesn't seem to
take effect, force it: add `--no-cache` to a `build` first.

## Wait for health

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml ps
```

`notification-service` waits only on RabbitMQ, so it comes up fast.

## One-command verification

```powershell
.\scripts\verify-phase4.ps1
```

Runs the full Phase 3 saga verification AND checks that the notification
service received fan-out copies of the events (one notification per
customer-relevant event, attributed to the right user).

## Manual demo — SEE the fan-out

1. Tail the notifier in one terminal:

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml logs -f --tail=10 notification-service
```

2. Place any order (see PHASE3_RUNBOOK for the token + order commands). Watch
   `NOTIFICATION sent (simulated)` lines appear — the SAME events the saga
   consumed, delivered again to this service's own queue.

3. Inspect what was "sent" (debug port, bypasses Traefik):

```powershell
curl.exe -s http://localhost:3006/notifications
```

4. Prove it's a separate queue on the same exchange:

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml exec rabbitmq rabbitmqctl list_bindings source_name destination_name routing_key | Select-String -Pattern "notification"
```

Expected: `notification.events` bound to `ecommerce.events` for
`order.created`, `payment.succeeded`, `payment.failed`, `inventory.rejected`.

## What "working" looks like

| Check | Pass criterion |
|---|---|
| `ps` health | all 16 containers healthy |
| CONFIRMED order | notifications: "We received your order" + "Your order is confirmed" |
| FAILED order | notifications: "...received..." + "Payment failed — your order was cancelled" |
| REJECTED order | notifications: "...received..." + "...out of stock" |
| Attribution | each notification `to` = `user:<your userId>` (not `user:unknown`) |
| Bindings | `notification.events` queue bound to the topic exchange |
| Saga regression | all Phase 3 checks still PASS (fan-out changed no producer behavior) |
