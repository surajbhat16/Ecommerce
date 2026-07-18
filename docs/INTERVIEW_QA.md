# Senior DevOps Interview Q&A — Phase 1 Concepts

Detailed model answers for the container/Docker concepts demonstrated in Phase 1.
These are written at the depth a senior/staff DevOps interview at a top-tier
company would probe. Each answer states the principle, the mechanism, and the
trade-off — which is what separates a senior answer from a junior one.

---

### 1. Why multi-stage builds, and what concretely is removed from the final image?

A multi-stage build uses several `FROM` stages where only the final stage ships.
We build in a fat stage (full toolchain, dev dependencies, TypeScript compiler)
and copy **only the compiled artifacts and pruned production `node_modules`** into
a slim runtime stage.

What's removed from the shipped image: the TypeScript source, the compiler, all
`devDependencies`, the npm cache, and any build-time files. The payoff is concrete:
a smaller image (faster pulls, faster pod/container starts, lower registry cost), a
**smaller attack surface** (no compilers or dev tooling for an attacker to leverage),
and **fewer CVEs** flagged by scanners because there's simply less software present.

Senior nuance: each stage is independently cacheable. By copying `package.json`
before the source, the dependency-install layer is cached and only re-runs when
dependencies change — not on every code edit. That's layer-caching discipline.

---

### 2. Liveness vs readiness probes — what's the difference and why does conflating them cause outages?

**Liveness** answers "is the process alive?" Failure → the orchestrator **restarts**
the container. **Readiness** answers "can I serve traffic right now?" Failure → the
orchestrator **stops routing traffic** to this instance but does **not** restart it.

The critical rule: **liveness must not check downstream dependencies.** If your
liveness probe pings the database and the database has a transient blip, *every*
replica fails liveness simultaneously and the orchestrator restart-storms all of
them — turning a brief DB hiccup into a full application outage and a thundering
herd of reconnects when they all come back. Readiness *should* check dependencies,
because if you can't reach the DB you genuinely can't serve, so you should be pulled
from the load-balancer rotation until you can.

In this project: `/health/live` returns cheaply without touching anything;
`/health/ready` calls `ping()` against Postgres and returns 503 if it's down.

---

### 3. Why store secrets as mounted files instead of environment variables?

Environment variables leak through multiple channels: `docker inspect` prints the
full env, child processes inherit the parent's environment, crash dumps and error
loggers frequently serialise `process.env`, and orchestrator UIs display env. A
secret in an env var is therefore exposed far more widely than intended.

File-mounted secrets (Docker secrets are mounted into a `tmpfs`, in-memory, at
`/run/secrets/<name>`) avoid all of that: the value is only on a RAM-backed mount
readable by the container, never serialised into env or inspect output. The app
reads the file at startup. The convention is a `<NAME>_FILE` env var holding the
**path** (not the value) — which is safe to expose.

Senior nuance: Compose "secrets" are still files on the host disk, so this is good
hygiene, not a vault. Real production layers in a secrets manager (Vault, AWS/GCP
secret managers, SOPS-encrypted files) and short-lived dynamic credentials. The
*pattern* — never put the secret in env — is the same at every scale.

---

### 4. Explain the PID-1 / signal-handling problem and how `init: true` and exec-form CMD solve it.

In Linux, PID 1 is special: it must reap zombie (orphaned) child processes, and it
does **not** get default signal handlers. Two failure modes follow.

First, **shell-form `CMD`** (`CMD node dist/index.js`) launches a shell as PID 1,
which `fork`/`exec`s Node as a child. When Docker sends `SIGTERM` on
`docker stop`, the shell — not Node — receives it, and many shells don't forward
it. Node never hears SIGTERM, never runs its graceful-shutdown handler, and gets
`SIGKILL`ed after the grace period — cutting in-flight requests and leaking
connections. The fix: **exec-form `CMD`** (`CMD ["node","dist/index.js"]`) so Node
*is* PID 1 and receives signals directly.

Second, even as PID 1, Node isn't a great init — it won't reap zombies from
grandchild processes. `init: true` in Compose inserts a tiny init (tini) as PID 1
that forwards signals to your process **and** reaps zombies. We use both: exec-form
CMD and `init: true`.

In the app, `process.on('SIGTERM', shutdown)` stops accepting new connections,
drains in-flight requests, closes the DB pool, then exits 0.

---

### 5. How does Docker network segmentation provide defense in depth here?

We define three networks. `edge` (public-facing — only Traefik and the gateway),
`backend` (the service mesh), and `auth-data` (`internal: true` — only the auth
service and its database). `internal: true` means the network has **no gateway to
the outside**, so containers on it can't make outbound internet connections and
nothing routes in from the edge.

The security property: a database is reachable **only** by its owning service,
because only that service is attached to the private data network. A compromise of
the public edge can't reach a database directly — it would have to pivot through
the gateway, then a service, and only that service can touch its own data network.
This also *enforces* database-per-service at the topology level — a service
physically cannot connect to another service's DB because it isn't on that network.

Senior nuance: this is segmentation, not a substitute for authn/authz on the DB or
for network policies in Kubernetes (where you'd use `NetworkPolicy` objects to get
the same effect). It's one layer of several.

---

### 6. What do resource `limits` vs `reservations` actually do, and what happens at the limit?

`reservations` are a **soft floor** — a guaranteed minimum the scheduler ensures is
available. `limits` are a **hard ceiling** enforced by the kernel via cgroups.

At the **memory** limit: the kernel's OOM killer terminates the container (you'll
see exit code 137 = 128+SIGKILL). The app doesn't get to gracefully handle it — it's
killed. So you size memory limits with real headroom and watch for OOMKills as a
signal you've under-provisioned.

At the **CPU** limit: the process is **throttled**, not killed. CFS (the Linux
scheduler) caps the cgroup's CPU time per period, so the container just runs slower.
You detect this via throttling metrics, not crashes.

Why set them at all: without limits, one misbehaving container (a memory leak, a hot
loop) can starve every other container on the host — the "noisy neighbour" problem.
Limits contain the blast radius. Reservations ensure critical services aren't
starved by best-effort ones.

---

### 7. The gateway is scaled to multiple replicas. Why is that safe, and what makes load balancing possible?

It's safe because the gateway is **stateless** — it keeps no session state in
memory. Identity travels in the JWT the client presents on every request, so any
replica can handle any request; replicas are interchangeable. That's the
precondition for horizontal scaling: if a service held in-memory session state,
you'd need sticky sessions or a shared session store before you could scale it.

Traefik discovers all replicas (via the Docker provider) and round-robins across
them. We expose an `x-served-by-gateway` header carrying each replica's instance id
so you can *observe* the distribution changing across requests.

Senior nuance: this is the textbook "scale the stateless edge tier" pattern.
Contrast with stateful services (a WebSocket server holding live connections) where
scaling needs sticky sessions or a pub/sub backplane — a deliberately harder problem
we avoid by keeping the gateway stateless.

---

### 8. Why two layers at the edge — Traefik *and* an API gateway? Isn't that redundant?

They handle different concerns. **Traefik** is the reverse proxy / L7 load balancer:
TLS termination, certificate management, routing by host/path, spreading load across
replicas, and dynamic service discovery from Docker labels. The **API gateway** owns
*application* concerns: validating the JWT once at the mesh boundary, rate limiting,
injecting correlation/request ids for tracing, and routing to the correct upstream
service with auth context attached.

Could you merge them? Some setups do (e.g. an API gateway product that also
terminates TLS). We separate them deliberately because the concerns scale and change
independently: transport/TLS config rarely changes; routing and auth policy change
constantly. Separation keeps each simple and independently replaceable — you could
swap Traefik for Envoy without touching application auth logic.

---

### 9. `depends_on: condition: service_healthy` — what problem does it solve that plain `depends_on` doesn't?

Plain `depends_on` only waits for the dependency container to **start**, not to be
**ready**. Postgres "started" is not Postgres "accepting connections" — there's an
init window (especially first boot, when it creates the cluster and runs migrations)
where the process is up but the socket isn't serving. An app that connects in that
window crashes on startup.

`condition: service_healthy` makes Compose wait until the dependency's **healthcheck**
passes before starting the dependent. Our `auth-db` defines a `pg_isready`
healthcheck; `auth-service` waits for that to go green. This removes startup-ordering
race conditions without hacky `sleep`-based wait scripts.

Senior nuance: this only helps at **startup**. It does nothing for a dependency that
dies *later*, so the application still needs connection retries and a readiness probe
to handle runtime outages gracefully. Startup ordering and runtime resilience are
separate problems; you need both.

---

### 10. How do multiple Compose files combine, and why split them at all?

Compose merges files passed with repeated `-f` flags, left to right: later files
**deep-merge** over earlier ones (scalars overridden, lists/maps merged per
Compose's rules). A file literally named `docker-compose.override.yml` is merged
automatically on top of `docker-compose.yml` for plain `docker compose` commands.

We split by concern: `docker-compose.yml` (base topology + stateless services),
`docker-compose.data.yml` (the stateful data tier), `docker-compose.override.yml`
(dev-only conveniences like exposed debug ports). Benefits: you can bring the data
tier up independently; dev-only port exposure never contaminates a prod-like run;
and the same base composes cleanly with a future `docker-compose.prod.yml` that adds
replicas and strict limits while *omitting* the override. The Makefile encodes the
canonical `-f` chain so the topology is documented and you don't mistype it.

---

### 11. Why publish *no* host port for the gateway, yet it's still reachable?

The gateway has no `ports:` mapping in the base file — it's not directly reachable
from the host. It's reachable only because **Traefik** is on the same `edge` network
and proxies to it using Docker's internal DNS and the container port (declared via
the `loadbalancer.server.port` label). All external traffic must traverse the edge
proxy, which is exactly what you want: a single ingress point where TLS, routing, and
load balancing are enforced. Publishing a host port on the gateway would create a
second, unguarded entrance that bypasses the edge — a security and consistency hole.
(The dev override *does* expose it, but only for local debugging, and the prod
compose won't.)

---

### 12. Why mount the Docker socket read-only into Traefik, and what's the risk?

Traefik's Docker provider watches the Docker API (via `/var/run/docker.sock`) to
discover containers and read their routing labels. We mount the socket **read-only**
because Traefik only needs to *read* container metadata, not control Docker.

The risk being mitigated: the Docker socket is effectively **root on the host**.
Anything that can write to it can launch privileged containers, mount the host
filesystem, and escape to the host. So a container with read-write socket access
that gets compromised is a full host compromise. Read-only narrows what an attacker
could do, but doesn't eliminate the risk — even read access leaks information.

Senior nuance: the harder-but-better fix is a **socket proxy** (e.g. a small proxy
that exposes only the specific, read-only Docker API endpoints Traefik needs) so
Traefik never touches the real socket at all. That's the production hardening step;
mounting `:ro` is the pragmatic local version, and naming the proxy upgrade shows
you know where this goes next.

---

## How to use these in an interview

For each concept, lead with the **principle** (one sentence), then the **mechanism**
(how it actually works), then the **trade-off or limitation** (what it doesn't solve
and what you'd do at larger scale). That three-part structure is the difference
between "I configured this" and "I understand this."
