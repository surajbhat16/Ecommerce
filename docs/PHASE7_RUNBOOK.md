# Phase 7 — Run & Verify Runbook (the storefront UI)

Phase 7 adds ONE container: `storefront` — a static React SPA served by nginx,
behind the same Traefik edge. It gives the platform a clickable face.

## Prerequisites: regenerate the TLS cert (adds app.localhost)

The storefront is served at `https://app.localhost`, a new host that must be in
the cert's SANs. Regenerate certs once:

```powershell
bash scripts/generate-certs.sh
```

(If you skip this, the browser shows a cert warning for app.localhost.)

## Boot

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.observability.yml -f docker-compose.override.yml up --build -d
```

The storefront joins the existing stack (22 containers with observability).

## Open the storefront

Browse to **https://app.localhost** and accept the self-signed cert warning
(same as api.localhost). You'll see the Meridian storefront:

1. **Sign in / register** — create an account (auth flows through the gateway).
2. **Browse the catalog** — the three seeded products, filterable by category.
3. **Add to cart, place order** — or use the **Demo saga paths** shortcuts in
   the cart panel to fire the three deterministic outcomes directly.
4. **Watch the saga panel** — on checkout, a panel opens showing the order
   move to its terminal state, narrating the real events behind each step, with
   a link to open the trace in Jaeger.

## The architecture point (say this in an interview)

The UI is served at `app.localhost`, and `app.localhost/api/*` is ALSO routed to
the gateway (via a higher-priority Traefik router). So the browser is
**same-origin** for both the app and its API calls — no CORS, one auth boundary,
one TLS edge. The UI never talks to a backend service directly; every call goes
through the gateway exactly like the verify scripts' curl calls do.

## Verify

```powershell
.\scripts\verify-phase7.ps1
```

Confirms the SPA is served, same-origin /api routing works, catalog reads
succeed, and a full add-to-cart -> place-order flow reaches CONFIRMED through the
UI origin.

## Debug access

`http://localhost:3007` hits the storefront container directly (bypassing
Traefik) — useful for checking the static bundle in isolation. Note API calls
won't work from there (no /api routing), so use https://app.localhost for the
real thing.

## What "working" looks like

| Check | Pass criterion |
|---|---|
| https://app.localhost | Meridian storefront loads |
| Register/login | account created, signed in |
| Catalog | three products visible, category filter works |
| Place order (BOOK-001) | saga panel shows CONFIRMED |
| Demo LAPTOP-001 x1 | saga panel shows FAILED with compensation steps |
| Demo LAPTOP-001 x3 | saga panel shows REJECTED |
| Jaeger link | opens the tracing UI |
