# Phase 5 — Run & Verify Runbook (observability)

Cumulative: Phases 1–4 plus the observability layer. The compose chain gains a
FOURTH file. Run from the project root in PowerShell.

## The new compose chain

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.observability.yml -f docker-compose.override.yml up --build -d
```

Adds 5 containers (prometheus, grafana, loki, promtail, jaeger) → 21 total.
The observability file also overlays OpenTelemetry env onto every app service
(compose merges environment maps), so ALL app services restart with tracing.

Run WITHOUT the observability file and the platform behaves exactly as
Phase 4 — the layer is a feature flag.

**Rebuild note:** every service's package.json gained prom-client + the OTel
auto-instrumentation dependency, so this `up --build` rebuilds all images. If
metrics don't appear after an edit, suspect the Docker build cache and rebuild
with `--no-cache`.

## Wait for health

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.observability.yml -f docker-compose.override.yml ps
```

jaeger has no healthcheck (scratch image, no shell) — "running" is its normal
state. Everything else should reach healthy.

## One-command verification

```powershell
.\scripts\verify-phase5.ps1
```

Places orders, then checks all three pillars end-to-end: Prometheus targets up
and counting, Loki receiving labeled service logs, and Jaeger holding a
checkout trace that spans MULTIPLE services (proving context crossed RabbitMQ).

## The UIs

| Tool | URL | Login |
|---|---|---|
| Grafana | http://localhost:3030 | admin / admin |
| Prometheus | http://localhost:9090 | — |
| Jaeger | http://localhost:16686 | — |
| RabbitMQ mgmt | http://localhost:15672 | guest / guest |

## The 3 money demos (in order of interview impact)

1. **The cross-broker trace.** Place a CONFIRMED order (BOOK-001 x1), open
   Jaeger → service `order-service` → newest trace. One trace ID spanning
   gateway → order → RabbitMQ → inventory → payment. The trace context
   traveled inside AMQP message headers.
2. **The saga funnel as metrics.** Run all three demo orders, then Grafana →
   "E-Commerce Platform — Overview" → the orders-by-status panel: CONFIRMED /
   FAILED / REJECTED counted by the services themselves.
3. **Cross-service log query.** Grafana → Explore → Loki:
   `{service=~"order-service|inventory-service"} | json | msg=~".*compensation.*"`
   — both halves of a FAILED order's compensation, from two containers, in one
   timeline. (pino levels are numeric: 30=info, 40=warn, 50=error.)

## Notes

- Grafana's port is 3030 on the host (3000 is taken by auth's debug port).
- Prometheus scrapes every 10s — after placing orders, counters can take up to
  ~10s to appear. The verify script waits for this.
- Traefik metrics: internal entrypoint :8082 (never published). RabbitMQ
  metrics: internal :15692 via the rabbitmq_prometheus plugin.
- The app services do NOT depend on jaeger: the OTLP exporter fails soft.
  Telemetry must never take the platform down.
