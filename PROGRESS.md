# Project Roadmap & Progress

This file tracks the full arc of the build. Each phase ships as a **cumulative**
zip (everything from prior phases + the new layer, already integrated) with a
run-and-verify guide in the README.

---

## Phase 1 — Foundation & edge/auth slice ✅

**Services:** Traefik (edge), API Gateway (scaled/LB), Auth + PostgreSQL.

**Concepts established:**
- [x] Segmented networks: `edge` / `backend` / `auth-data` (internal)
- [x] Multi-stage Dockerfiles (deps → build → runtime), non-root
- [x] Docker secrets via files (`*_FILE`), not env vars
- [x] Liveness vs readiness health checks; `depends_on: service_healthy`
- [x] Resource limits + reservations on every container
- [x] Traefik reverse proxy, TLS termination, label-based routing
- [x] Load balancing across gateway replicas (round-robin)
- [x] Graceful shutdown (SIGTERM) + `init: true` (PID-1 problem)
- [x] Layered compose files + Makefile front door
- [x] Metrics/tracing **seams** (endpoints stubbed for Phase 5)

---

## Phase 2 — Synchronous read path ✅

**Adds:** Product Catalog (MongoDB + Redis cache), Cart (Redis).

- [x] Polyglot persistence (Mongo for flexible product schemas, Redis for carts)
- [x] Cache-aside pattern for catalog reads (hit/miss/populate/invalidate)
- [x] Catalog routes through the gateway (public), Cart routes (JWT-protected)
- [x] Per-service internal data networks (catalog-data, cart-data)
- [x] Redis as PRIMARY store (cart) vs Redis as CACHE (catalog) — distinct configs
- [x] MongoDB seed with varying per-category attributes; indexes (unique/text)
- [x] docs/CONCEPTS.md — four deep-dives with worked examples + 10+ Q&A each

---

## Phase 3 — The checkout saga ✅

**Adds:** Order, Payment, Inventory services + RabbitMQ.

- [x] Orchestration-based Saga with compensating transactions
- [x] Transactional Outbox pattern (atomic DB write + event publish)
- [x] Idempotency keys / processed-events tables; at-least-once delivery
- [x] Dead-letter exchange + queue for poison messages
- [x] Order state machine persisted across saga steps
- [x] Deterministic demo paths: CONFIRMED / FAILED (compensation) / REJECTED
- [x] Per-service internal data networks (order/payment/inventory-data)
- [x] docs/CONCEPTS.md — five deep-dives with worked examples + 10+ Q&A each

---

## Phase 4 — Event fan-out ✅

**Adds:** Notification service (pure event consumer).

- [x] Decoupled, async-only consumer: no database, no secrets, no publishing
- [x] Pub/sub fan-out: its own durable queue bound to the SAME topic exchange
      and routing keys the saga services consume — producers unchanged
- [x] Event-carried state transfer: order.created now carries userId; the
      consumer builds the orderId→user slice locally instead of calling back
- [x] Per-consumer idempotency strength: bounded in-memory dedupe (vs the
      inventory service's processed-events table) — matched to the stakes
- [x] docs/CONCEPTS.md — two deep-dives with worked examples + 10 Q&A each

---

## Phase 5 — Observability (three pillars) ✅

**Adds:** Prometheus, Grafana, Loki + Promtail, Jaeger + OpenTelemetry — as a
SEPARATE compose layer (docker-compose.observability.yml): run without it and
the platform behaves exactly as Phase 4; add it and 5 containers start plus
the app services gain OpenTelemetry via compose env merge.

- [x] METRICS: prom-client in all 8 services — Node default metrics + an
      http_request_duration_seconds R.E.D. histogram; domain counters
      (orders_terminal_total{status}, payments_total{outcome},
      inventory_reservations_total{outcome}, notifications_sent_total{event});
      Traefik metrics entrypoint (:8082); RabbitMQ prometheus plugin (:15692)
- [x] LOGS: Promtail discovers containers over the Docker socket, parses pino
      JSON, labels streams by compose service name → Loki (label-index model)
- [x] TRACES: OpenTelemetry auto-instrumentation loaded via NODE_OPTIONS
      --import (zero app-code changes); amqplib instrumentation propagates
      W3C trace context through RabbitMQ headers → ONE trace per checkout
      spanning gateway → order → broker → inventory → payment; Jaeger UI
- [x] DASHBOARDS: Grafana fully provisioned (datasources + platform overview:
      RED panels, saga funnel, queue depth, live Loki logs)
- [x] docs/CONCEPTS.md — three deep-dives with worked examples + 10 Q&A each

---

## Phase 6 — CI/CD, scanning, prod-like compose ✅ (current)

**Adds:** GitHub Actions pipeline, Trivy image scanning, GHCR publishing,
`docker-compose.prod.yml`, per-service lockfiles.

- [x] Reproducible installs: package-lock.json generated for all 8 services —
      the Dockerfiles' `npm ci || npm install` now takes the `ci` path
- [x] Pipeline (.github/workflows/ci.yml):
      hadolint (Dockerfile lint) + build-test (npm ci + tsc, matrix ×8)
      → image-build-scan (docker build + Trivy gate on fixable CRITICAL/HIGH)
      → compose-smoke (ENTIRE platform booted in CI; saga driven through all
        three terminal paths + compensation + fan-out asserted)
      → push-images (main only: GHCR, immutable SHA tag + latest)
- [x] Prod overlay (docker-compose.prod.yml): dev override omitted → zero
      debug ports; Traefik dashboard port stripped via `!override`;
      2 gateway replicas behind Traefik; no-new-privileges + log rotation
      everywhere; NODE_ENV=production
- [x] docs/CONCEPTS.md — three deep-dives with worked examples + 10 Q&A each
- [ ] (Optional, future) `kind` single-node Kubernetes deployment using the
      clean seams
---

## Deferred / explicitly out of scope (and why)

- **Multi-host orchestration / cloud autoscaling** — requires real infrastructure;
  the patterns (horizontal scaling, LB, health-gated traffic) are all demonstrated
  locally. The README explains how this maps to a multi-host deployment.
