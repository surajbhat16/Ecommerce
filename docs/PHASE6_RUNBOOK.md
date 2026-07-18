# Phase 6 — Run & Verify Runbook (CI/CD, scanning, prod-like compose)

Phase 6 adds no new runtime containers. It adds the DELIVERY layer: a GitHub
Actions pipeline, Trivy scanning, GHCR publishing, per-service lockfiles, and
a production compose overlay.

## Local verification (no GitHub needed)

```powershell
.\scripts\verify-phase6.ps1
```

Checks: lockfiles exist for all 8 services, workflow + prod overlay are
structurally sound, and — the key one — the rendered prod chain publishes
ONLY ports 80/443 and runs 2 gateway replicas.

## Boot the prod-like chain

Bring the dev stack down first (shared host ports 80/443):

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.observability.yml -f docker-compose.override.yml down
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.prod.yml up -d --build
```

What to observe:
- `docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.prod.yml ps` -> `api-gateway` shows **2 replicas**
- http://localhost:8081 (Traefik dashboard) **no longer connects** — port stripped via `!override`
- No :3000-3006, :9090 etc. — the dev override is absent
- The app still works through the edge: run `bash scripts/smoke-test.sh`

Add `-f docker-compose.observability.yml` before the prod file if you want
the monitoring stack in the prod-like run too.

## Wiring up GitHub (one-time)

1. Create a GitHub repository and push this project (`.github/workflows/ci.yml`
   ships in the zip — Actions picks it up automatically).
2. First push to `main` runs the full pipeline. PRs run everything EXCEPT the
   GHCR push.
3. GHCR: no setup needed — the workflow uses the built-in `GITHUB_TOKEN` with
   `packages: write` scoped to the push job only. Images appear under your
   profile → Packages as `ecommerce-<service>:<sha>` and `:latest`.
4. Recommended: branch protection on `main` requiring the `compose-smoke` and
   `image-build-scan` checks — that's the merge gate.

## Pipeline stages (what runs on every push/PR)

| Stage | What | Fails when |
|---|---|---|
| build-test (×8) | npm ci + tsc per service | type errors, lockfile drift |
| hadolint | lint all Dockerfiles | Dockerfile errors |
| image-build-scan (×8) | docker build + Trivy | fixable CRITICAL/HIGH CVE |
| compose-smoke | full 16-container boot + saga E2E | any integration break |
| push-images (×8) | GHCR push, SHA + latest tags | (main only, needs all green) |

## Notes

- CI scripts are bash (`smoke-ci.sh`, `wait-healthy.sh`) because runners are
  Linux; your local scripts remain PowerShell.
- Trivy results change over time as CVE databases update — a build can fail
  tomorrow with zero code changes. That's the system working; bump the base
  image or the affected dependency.
- The optional `kind` Kubernetes deployment remains future work (PROGRESS.md).
