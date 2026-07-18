# Production-Grade E-Commerce Microservices Platform — Phase 1

A locally-runnable, production-patterned microservices system built to demonstrate
**DevOps / container engineering** depth: multi-stage builds, Docker secrets,
health checks, resource limits, network segmentation, a reverse proxy + load
balancer, and the seams for full observability and CI/CD.

> **This is Phase 1 — the foundation slice.** It stands up the edge, the API
> gateway (scaled + load-balanced), and the Auth service with its own private
> PostgreSQL. Every cross-cutting production pattern is established here so later
> services just reuse the template. See `PROGRESS.md` for the full roadmap.

---

## What Phase 1 demonstrates

| Concern | How it's shown here |
|---|---|
| **Multi-stage builds** | Every service: `deps → build → runtime`, non-root, slim runtime image |
| **Secrets management** | Docker secrets mounted at `/run/secrets/*`, read via `*_FILE`; never env vars |
| **Health checks** | Liveness vs readiness split; `depends_on: service_healthy` gating |
| **Resource limits** | CPU + memory `limits`/`reservations` on every container |
| **Network segmentation** | `edge` / `backend` / `auth-data` (internal); DB unreachable from edge |
| **Reverse proxy** | Traefik terminates TLS, routes by Docker labels |
| **Load balancing** | Gateway scaled to N replicas; Traefik round-robins across them |
| **Graceful shutdown** | SIGTERM handling + `init: true` (tini) solving the PID-1 problem |
| **12-factor config** | Strict env/secret separation; stateless services (k8s-ready seams) |

---

## Prerequisites

- Docker Engine + Docker Compose v2 (`docker compose version`)
- `make`, `bash`, `openssl`, `curl` (standard on macOS/Linux; on Windows use WSL2)
- Add these to your hosts file so the local domains resolve:

  ```
  127.0.0.1 api.localhost traefik.localhost
  ```
  (On most systems `*.localhost` already resolves to 127.0.0.1 and you can skip this.)

---

## Run it — step by step

> Follow this order. Each step says what to run and what "healthy" looks like.

### 1. One-time setup — generate secrets and TLS cert

```bash
make init
```

This runs `generate-secrets.sh` (random DB password + JWT key into
`infra/secrets/*.txt`, gitignored) and `generate-certs.sh` (a self-signed cert for
local HTTPS). **Expected:** lines like `generated: auth_db_password.txt` and
`Generated self-signed cert ...`.

### 2. Build and start the stack

```bash
make up
```

This builds all images (multi-stage) and starts everything detached. **Expected:**
container list, then the printed URLs.

### 3. Watch it become healthy

```bash
make status
```

Re-run until every service shows `healthy`. **Expected:** `auth-db` healthy first,
then `auth-service` (it waits for the DB), then `api-gateway` and `traefik`.

> If `auth-service` is stuck "starting": it's waiting on the DB healthcheck — give
> it ~15s on first boot while Postgres initialises and runs the migration.

### 4. Smoke-test the full path (client → Traefik → Gateway → Auth → Postgres)

```bash
make smoke
```

**Expected:** a `201` registration, a login returning `accessToken`/`refreshToken`,
a protected `/whoami` returning your `userId`, and a `401` when the token is omitted.

---

## Prove each concept (the "show me" commands)

These are designed so you can *demonstrate* each pattern — useful for interviews.

### Load balancing across gateway replicas

```bash
make scale-gateway     # scale gateway to 3 replicas
make demo-lb           # fire 6 requests; watch x-served-by-gateway change
```

**What you're seeing:** Traefik round-robins requests across the 3 stateless
gateway replicas. The `x-served-by-gateway` header changes between responses —
that's the load balancer at work. (Why can we scale it freely? Because the gateway
holds no state; identity lives in the JWT.)

### Secrets are not leaking into the environment

```bash
make demo-secrets
```

**What you're seeing:** `docker ... env` shows only `JWT_SIGNING_KEY_FILE` (a path),
**not** the secret value. The actual key exists only as a file under `/run/secrets/`.
This is why we use file-based secrets — `docker inspect`/env dumps can't leak them.

### Self-healing via restart policy

```bash
make demo-healing
```

**What you're seeing:** killing `auth-service` triggers `restart: unless-stopped`,
and Docker brings it back. Combined with the readiness probe, traffic only resumes
once it's actually ready again.

### Network segmentation (the DB is isolated)

```bash
# The gateway is on edge+backend but NOT on auth-data, so it cannot reach the DB:
docker compose -f docker-compose.yml -f docker-compose.data.yml \
  exec api-gateway node -e "fetch('http://auth-db:5432').catch(e=>{console.log('blocked:', e.code);process.exit(0)})"
```

**What you're seeing:** the gateway can't resolve/reach `auth-db` because it isn't
attached to the `auth-data` network. Only `auth-service` is. Database-per-service,
enforced at the network layer.

---

## Architecture (Phase 1)

```
                       ┌──────────────────────┐
   client ──HTTPS────▶ │       Traefik        │   edge network
                       │  TLS + load balancer  │
                       └───────────┬──────────┘
                                   │  (round-robins across gateway replicas)
                     ┌─────────────┼─────────────┐
                     ▼             ▼             ▼
                ┌─────────┐  ┌─────────┐  ┌─────────┐
                │ gateway │  │ gateway │  │ gateway │   (stateless, scaled)
                └────┬────┘  └────┬────┘  └────┬────┘
                     └────────────┼────────────┘   backend network
                                  ▼
                          ┌───────────────┐
                          │ auth-service  │
                          └───────┬───────┘
                                  │  auth-data network (internal: true)
                          ┌───────▼───────┐
                          │   auth-db     │  (PostgreSQL, isolated)
                          └───────────────┘
```

---

## Project layout

```
.
├── docker-compose.yml            # BASE: networks, traefik, gateway, auth, secrets
├── docker-compose.data.yml       # DATA: auth postgres
├── docker-compose.override.yml   # DEV: host port exposure for debugging
├── Makefile                      # the front door (make help)
├── PROGRESS.md                   # full roadmap + what each phase adds
├── docs/
│   └── INTERVIEW_QA.md           # senior DevOps interview Q&A for Phase 1 concepts
├── infra/
│   ├── secrets/                  # *.txt (gitignored) + *.example templates
│   └── traefik/                  # static + dynamic config, certs
├── scripts/                      # init, certs, secrets, smoke test
└── services/
    ├── gateway/                  # API gateway (TS) — multi-stage Dockerfile
    └── auth/                     # auth service (TS) + db migrations
```

---

## Design decisions worth defending (interview ammunition)

- **Two layers at the edge (Traefik + Gateway).** Traefik owns *transport*
  (TLS, L7 load balancing); the gateway owns *application* concerns (routing,
  JWT validation, rate limiting). Separation of concerns, independently scalable.
- **Database-per-service, enforced by network.** `auth-data` is `internal: true`
  and only the auth service + its DB attach to it. Not just convention — topology.
- **Secrets as files, not env.** Env vars leak via `docker inspect`, child
  processes, and logs. File-mounted secrets don't.
- **Liveness ≠ readiness.** Liveness must not check dependencies (avoids restart
  storms during a DB blip); readiness does (stops traffic to an instance that
  can't serve). Mixing them is a classic mistake interviewers probe.
- **Known limitation — rate limiting is per-replica.** In-memory counters mean N
  replicas allow N×max. The fix is a shared Redis store; we add it later. Naming
  your own limitations is a senior signal.

See `docs/INTERVIEW_QA.md` for 12+ detailed Q&A on these.

---

## Common issues

- **Browser warns about the certificate** — expected; it's self-signed. Proceed,
  or use `curl -k`.
- **`api.localhost` doesn't resolve** — add it to `/etc/hosts` (see Prerequisites).
- **Port 80/443/5433 already in use** — stop the conflicting local service, or
  edit the published ports in the override file.
- **`auth-service` won't go healthy** — check `make logs-auth`; usually the DB
  hasn't finished first-time init. Wait, or `make clean && make up` to reset.

---

## Next: Phase 2

Product Catalog (MongoDB + Redis cache) and Cart (Redis) — the synchronous read
path — plus the catalog/cart routes wired through the gateway. See `PROGRESS.md`.
