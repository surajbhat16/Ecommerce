# Production-Grade E-Commerce Microservices Platform

[![ci](https://github.com/surajbhat16/ECommerce/actions/workflows/ci.yml/badge.svg)](https://github.com/surajbhat16/ECommerce/actions/workflows/ci.yml)

A locally-runnable, production-patterned microservices system built to demonstrate
**DevOps and container-engineering depth** end to end: multi-stage image builds,
file-based secrets, liveness/readiness probes, resource limits, network
segmentation, a TLS-terminating edge proxy, an event-driven checkout saga over a
message broker, a full three-pillar observability stack, and a complete CI/CD
pipeline with image scanning and a production compose profile.

The focus throughout is **infrastructure and delivery engineering**, not business
logic. Every service is intentionally thin; the interesting parts are how the
services are built, wired, secured, observed, and shipped.

> Built in seven cumulative phases. Each phase adds one architectural capability and
> reuses the patterns established before it. See `PROGRESS.md` for the phase log and
> `docs/CONCEPTS.md` for 18 concept deep-dives with **197 senior interview Q&A**.

---

## Table of contents

- [What this platform demonstrates](#what-this-platform-demonstrates)
- [The seven phases at a glance](#the-seven-phases-at-a-glance)
- [Full architecture](#full-architecture)
- [The services](#the-services)
- [Quick start](#quick-start)
- [Verifying each phase](#verifying-each-phase)
- [The three demo saga paths](#the-three-demo-saga-paths)
- [Observability](#observability)
- [CI/CD pipeline](#cicd-pipeline)
- [Production profile](#production-profile)
- [Project layout](#project-layout)
- [Design decisions worth defending](#design-decisions-worth-defending)
- [Documentation](#documentation)

---

## What this platform demonstrates

| Concern | How it is shown |
|---|---|
| **Multi-stage builds** | Every service: `deps -> build -> runtime`, non-root `USER node`, slim runtime |
| **Secrets management** | Docker secrets mounted at `/run/secrets/*`, read via `*_FILE`; never plain env |
| **Health checks** | Liveness vs readiness split; `depends_on: service_healthy` gating startup order |
| **Resource limits** | CPU + memory `limits`/`reservations` on every container |
| **Network segmentation** | `edge` / `backend` / per-datastore internal networks; DBs unreachable from the edge |
| **Reverse proxy + TLS** | Traefik terminates HTTPS, routes by Docker labels, load-balances replicas |
| **Cache-aside** | Catalog reads MongoDB through a Redis cache |
| **Saga orchestration** | Checkout coordinated across Order/Payment/Inventory with compensation |
| **Transactional outbox** | Atomic DB-write + event-publish, no dual-write data loss |
| **Idempotency** | Duplicate events deduplicated; at-least-once delivery made safe |
| **Dead-letter queue** | Poison messages isolated without blocking the main queue |
| **Pub/sub fan-out** | Notification service consumes the same events via its own queue |
| **Metrics** | Prometheus scrapes RED histograms + domain counters from all 8 services |
| **Centralized logs** | Promtail ships structured pino JSON to Loki, labeled by service |
| **Distributed tracing** | OpenTelemetry traces one checkout across services AND the broker |
| **CI/CD** | GitHub Actions: lint -> build/test -> scan -> full-stack smoke -> GHCR publish |
| **Supply-chain security** | hadolint + Trivy CVE gate; `no-new-privileges` runtime hardening |
| **Dev/prod parity** | Layered compose; prod profile strips debug ports and scales the gateway |

---

## The seven phases at a glance

| Phase | Capability added | Key services / infra |
|---|---|---|
| **1** | Edge, auth, foundation patterns | Traefik, API Gateway (JWT, rate limit), Auth + PostgreSQL |
| **2** | Synchronous read path | Catalog (MongoDB + Redis cache-aside), Cart (Redis primary store) |
| **3** | Async write path — the checkout saga | Order orchestrator, Payment, Inventory, RabbitMQ (outbox, idempotency, DLQ) |
| **4** | Event fan-out | Notification service (pure event consumer, event-carried state transfer) |
| **5** | Observability (three pillars) | Prometheus, Grafana, Loki + Promtail, Jaeger + OpenTelemetry |
| **6** | Delivery & hardening | GitHub Actions CI/CD, Trivy, GHCR, production compose profile |
| **7** | Storefront UI | React (Vite + TS) SPA, static nginx image, same-origin behind Traefik |

---

## Full architecture

```
                                  HTTPS (TLS terminated at the edge)
                                            │
                                  ┌─────────▼──────────┐
   ┌──────────────┐              │      Traefik        │      edge network
   │  Prometheus  │─ scrapes ───▶│  reverse proxy +    │  routes by Docker labels,
   │  (metrics)   │   :8082      │  TLS + load balancer │  round-robins gateway replicas
   └──────┬───────┘              └─────────┬──────────┘
          │                     Host(app.localhost)  │  Host(app.localhost)+/api/*
          │                     priority 1 ──┐        └── priority 10 (wins on /api)
          │                                  ▼                        │
          │                        ┌──────────────────┐               │
          │                        │    Storefront     │               │
          │                        │  (React SPA via   │               │
          │                        │   nginx, :8080)    │              │
          │                        └────────────────────┘              │
          │                     Host(api.localhost) OR app.localhost/api/* ▼
          │ scrapes /metrics     ┌─────────────────────┐
          │ from every service   │    API Gateway      │  JWT validation, rate limiting
          │                      │  (2+ stateless      │  injects x-user-id downstream
          │                      │   replicas)         │
          │                      └─────────┬──────────┘
          │                                │  backend network
          │        ┌───────────────┬───────┼────────────┬──────────────────┐
          │        ▼               ▼       ▼            ▼                  ▼
          │   ┌─────────┐   ┌───────────┐ ┌──────┐ ┌──────────┐    ┌──────────────┐
          │   │  Auth   │   │  Catalog  │ │ Cart │ │  Order   │    │ Notification │
          │   │         │   │           │ │      │ │ (saga    │    │  (consumer)  │
          │   └────┬────┘   └─────┬─────┘ └──┬───┘ │ orchestr.)│    └──────▲───────┘
          │        │              │          │     └────┬─────┘           │
          │   auth-data      catalog-data  cart-data    │                 │
          │        │           │      │       │         │  publishes /    │ consumes
          │   ┌────▼───┐  ┌────▼──┐ ┌─▼───┐ ┌─▼────┐    │  consumes       │ (fan-out)
          │   │auth-db │  │ mongo │ │redis│ │redis │    │  events         │
          │   │(pgsql) │  │       │ │cache│ │(cart)│    ▼                 │
          │   └────────┘  └───────┘ └─────┘ └──────┘  ┌──────────────────────────┐
          │                                           │        RabbitMQ           │
          │        ┌──────────┐      ┌──────────┐     │  topic exchange + durable │
          │        │ Payment  │◀────▶│Inventory │◀───▶│  queues + dead-letter     │
          │        │          │      │          │     │  (trace context in headers)│
          │        └────┬─────┘      └────┬─────┘     └──────────────────────────┘
          │        payment-db        inventory-db
          │        (pgsql)           (pgsql)
          │
          │   OBSERVABILITY (separate compose layer — a feature flag)
          └──▶ Prometheus ─┐
               Loki ◀── Promtail (Docker socket → all container logs)
               Jaeger ◀── OpenTelemetry (OTLP; context crosses RabbitMQ)
               Grafana ─── dashboards over Prometheus + Loki + Jaeger
```

Every datastore sits on its own `internal: true` network, reachable only by its
owning service — database-per-service enforced at the network layer, not by
convention. The observability stack lives in its own compose file: omit it and the
platform runs exactly as before; add it and five containers plus zero-code
OpenTelemetry instrumentation switch on.

The storefront and the API share one hostname. `app.localhost/*` goes to the
storefront container (priority 1); `app.localhost/api/*` is matched by a
higher-priority router (10) that sends the request straight to the gateway
instead. The browser is same-origin for both the page and its API calls — no
CORS, one auth boundary, one TLS edge — even though two different containers
answer.

---

## The services

| Service | Stack | Role | Datastore |
|---|---|---|---|
| **gateway** | Node/TS, Fastify | Edge app layer: JWT auth, rate limiting, routing | — (stateless) |
| **auth** | Node/TS, Fastify | Register/login, issues JWTs | PostgreSQL (private) |
| **catalog** | Node/TS, Fastify | Product reads via cache-aside | MongoDB + Redis cache |
| **cart** | Node/TS, Fastify | Shopping cart | Redis (primary store) |
| **order** | Node/TS, Fastify | Checkout saga orchestrator + state machine | PostgreSQL + outbox |
| **payment** | Node/TS | Payment authorization (deterministic demo) | PostgreSQL |
| **inventory** | Node/TS | Stock reservation + compensation | PostgreSQL |
| **notification** | Node/TS | Pure event consumer (pub/sub fan-out) | none (in-memory projection) |
| **storefront** | React + Vite + TS, nginx | The UI: browse, cart, checkout, live saga panel | — (stateless SPA) |

The eight backend services share the same patterns: multi-stage Dockerfile,
non-root runtime, file-based secrets, liveness/readiness probes, structured pino
logging, graceful shutdown, and (Phase 5) Prometheus metrics + OpenTelemetry
tracing. The storefront is a static SPA — no Node in its runtime image, no
secrets, no application logging — so it opts out of the patterns that don't
apply to it.

---

## Quick start

**Prerequisites:** Docker Engine + Docker Compose v2, plus `bash`, `openssl`, and
`curl`. On Windows, run the shell scripts via WSL2 or Git Bash; the verify scripts
are PowerShell.

```bash
# 1. Generate local secrets and a self-signed TLS cert (gitignored, never committed)
bash scripts/generate-secrets.sh
bash scripts/generate-certs.sh

# 2. Boot the full stack including observability (23 containers)
docker compose -f docker-compose.yml -f docker-compose.data.yml \
  -f docker-compose.observability.yml -f docker-compose.override.yml up --build -d

# 3. Wait until every container is healthy
docker compose -f docker-compose.yml -f docker-compose.data.yml \
  -f docker-compose.observability.yml -f docker-compose.override.yml ps
```

For the core platform without observability, drop the
`-f docker-compose.observability.yml` file — everything else is identical.

**Windows note (PowerShell 5.1):** the verify scripts use `curl.exe` with
`-H "Expect:"` and file-based JSON bodies to work around 5.1's HTTP quirks
(self-signed cert handling and the `Expect: 100-continue` header the proxy
rejects). This is baked in; no action needed.

**Local URLs**

| URL | What |
|---|---|
| `https://app.localhost` | The storefront UI (register/login, browse, cart, checkout) |
| `https://api.localhost` | The platform edge (via Traefik) |
| `http://localhost:8081` | Traefik dashboard |
| `http://localhost:15672` | RabbitMQ management (guest/guest) |
| `http://localhost:3030` | Grafana (admin/admin) |
| `http://localhost:9090` | Prometheus |
| `http://localhost:16686` | Jaeger tracing UI |

---

## Verifying each phase

Each phase ships a PowerShell verification script that drives the running stack and
asserts behavior with green/red output.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # once per terminal

.\scripts\verify-phase3.ps1   # saga: all three terminal paths + outbox/idempotency/DLQ
.\scripts\verify-phase4.ps1   # fan-out: notifications delivered + attributed
.\scripts\verify-phase5.ps1   # observability: metrics + logs + a cross-service trace
.\scripts\verify-phase6.ps1   # delivery: lockfiles + prod profile renders correctly
.\scripts\verify-phase7.ps1   # storefront: same-origin routing + full UI flow through the real gateway
```

---

## The three demo saga paths

Checkout is a saga orchestrated by the Order service over RabbitMQ. Three
deterministic paths demonstrate the full lifecycle including rollback:

| Order | Outcome | What it proves |
|---|---|---|
| `BOOK-001 x1` | **CONFIRMED** | Happy path: reserve stock -> authorize payment -> confirm |
| `LAPTOP-001 x1` | **FAILED** (compensated) | Payment declines -> **compensating transaction** releases the reserved stock |
| `LAPTOP-001 x3` | **REJECTED** | Insufficient stock -> rejected before payment; nothing to compensate |

The FAILED path is the important one: it shows the saga rolling back partial work
via an `inventory.release` compensating event, verified by stock returning to its
starting level.

---

## Observability

Three pillars, wired to answer three different questions:

- **Metrics (Prometheus + Grafana)** — *what* is happening. Every service exposes a
  RED histogram (`http_request_duration_seconds`) plus domain counters
  (`orders_terminal_total{status}`, `payments_total{outcome}`, etc.). Labels are
  bounded to closed sets to keep cardinality safe. A provisioned Grafana dashboard
  shows request rates, p95 latency, the saga funnel, queue depth, and live logs.
- **Logs (Loki + Promtail)** — *why* it happened. Promtail discovers containers over
  the Docker socket, parses the pino JSON, and labels each stream by service — the
  same label key the metrics use, so Grafana pivots between them.
- **Traces (Jaeger + OpenTelemetry)** — *where* it happened. Auto-instrumentation is
  loaded via `NODE_OPTIONS --import` with **zero application code changes**. The
  amqplib instrumentation propagates W3C trace context through RabbitMQ message
  headers, so a single checkout trace spans the gateway, order, broker, inventory,
  and payment — the most compelling artifact in the project.

---

## CI/CD pipeline

`.github/workflows/ci.yml` runs on every push and pull request, ordered
cheap-to-expensive so failures surface fast:

```
hadolint ─┐
          ├─▶ image-build-scan (matrix ×8, Trivy CVE gate) ─┐
build-test┘                                                 ├─▶ push-images
                       compose-smoke (full stack in CI) ────┘   (main only)
```

- **build-test** (matrix ×8): `npm ci` (lockfile-exact) + `tsc` per service.
- **hadolint**: lints every Dockerfile.
- **image-build-scan** (matrix ×8): builds each image and fails on fixable
  CRITICAL/HIGH CVEs via Trivy.
- **compose-smoke**: boots the entire platform inside the runner and drives the
  saga end-to-end — catching integration breaks no unit test can see.
- **push-images**: on `main` only, after everything is green, publishes each image
  to GHCR tagged with the immutable commit SHA plus `latest`.

Reproducible builds are guaranteed by per-service `package-lock.json` files, so the
Dockerfiles' `npm ci` path installs identical dependency trees every time.

---

## Production profile

`docker-compose.prod.yml` is a production-like overlay. Because every debug port
lives in the dev override file, prod is achieved by **omission**:

```bash
# dev:   base + data + observability + override  (all the conveniences)
# prod:  base + data + prod                       (override absent)
docker compose -f docker-compose.yml -f docker-compose.data.yml \
  -f docker-compose.prod.yml up -d --build
```

This yields: only ports 80/443 published (Traefik's dashboard port stripped via the
`!override` tag), two gateway replicas load-balanced by Traefik, `no-new-privileges`
and log rotation on every container, and `NODE_ENV=production`. The file documents
its own honest gaps (demo credentials, self-signed certs) as the register of what a
real deployment would harden next.

---

## Project layout

```
.
├── .github/workflows/ci.yml          # CI/CD pipeline
├── docker-compose.yml                # BASE: networks, traefik, gateway, all services
├── docker-compose.data.yml           # DATA: every datastore
├── docker-compose.observability.yml  # OBSERVABILITY layer (Prometheus/Grafana/Loki/Jaeger)
├── docker-compose.override.yml       # DEV: host port exposure for debugging
├── docker-compose.prod.yml           # PROD: hardening, replicas, no debug ports
├── Makefile                          # convenience front door
├── PROGRESS.md                       # phase-by-phase log
├── docs/
│   ├── CONCEPTS.md                   # 18 deep-dives, 197 senior interview Q&A
│   ├── PHASE{3..6}_CONCEPTS.pdf      # typeset concept documents
│   └── PHASE{2..7}_RUNBOOK.md        # run/verify runbooks per phase
├── infra/
│   ├── secrets/                      # *.txt (gitignored) + *.example templates
│   ├── traefik/                      # static + dynamic config, certs (gitignored)
│   ├── prometheus/  loki/  promtail/ # observability configs
│   ├── grafana/                      # provisioned datasources + dashboards
│   └── rabbitmq/                     # prometheus plugin enablement
├── scripts/                          # secrets/cert generation, smoke + verify scripts
└── services/                         # the 9 services, each a multi-stage Dockerfile
    ├── gateway/  auth/  catalog/  cart/
    ├── order/  payment/  inventory/  notification/
    └── storefront/                   # React SPA (Vite build -> nginx runtime)
```

---

## Design decisions worth defending

- **Two layers at the edge.** Traefik owns transport (TLS, L7 load balancing); the
  gateway owns application concerns (routing, JWT, rate limiting). Separately
  scalable, separately reasoned about.
- **Database-per-service, enforced by network.** Each datastore's network is
  `internal: true`; only its owner attaches. Isolation is topology, not etiquette.
- **Secrets as files, not env.** Environment variables leak via `docker inspect`,
  child processes, and logs. File-mounted secrets do not.
- **Liveness is not readiness.** Liveness avoids dependency checks (no restart storms
  during a DB blip); readiness includes them (stop routing to an instance that can't
  serve). Conflating them is a classic mistake.
- **Orchestration over choreography for the saga.** The checkout logic lives in one
  place (the Order service) — explicit, traceable, changeable — at the cost of a
  central coordinator. Defensible either way; the point is being able to argue it.
- **Transactional outbox over dual writes.** Writing the DB row and the event in one
  transaction removes the window where a crash leaves them inconsistent.
- **Per-consumer idempotency strength.** Inventory uses a durable processed-events
  table (money-adjacent); notification uses a bounded in-memory set (a duplicate
  email is harmless). Matching the mechanism to the blast radius, not maxing it
  everywhere.
- **Observability as a compose layer.** Tracing loads via `NODE_OPTIONS` only when
  the observability file is present — zero overhead and zero code coupling when it
  is not.
- **Prod by omission.** Debug ports never reach prod because they live only in the
  dev override; the prod chain simply does not include that file. Config you cannot
  forget to remove.

---

## Documentation

- **`PROGRESS.md`** — what each phase adds and why, with checkboxes.
- **`docs/CONCEPTS.md`** — 18 concept deep-dives (saga, outbox, idempotency,
  delivery semantics, DLQ, fan-out, event-carried state transfer, the three
  observability pillars, CI/CD, supply-chain security, dev/prod parity, serving a
  SPA behind a reverse proxy), each with minute sub-concepts, worked examples from
  this codebase, and 10 senior interview Q&A. **197 Q&A total.**
- **`docs/PHASE*_RUNBOOK.md`** — step-by-step run and verify instructions per phase.
- **`docs/PHASE*_CONCEPTS.pdf`** — the concept deep-dives, typeset for reading.

---

*Built as a DevOps portfolio project: production patterns, honestly labeled
limitations, and every architectural claim verified by a script you can run.*
