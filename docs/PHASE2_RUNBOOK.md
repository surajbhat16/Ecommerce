# Phase 2 — Run & Verify Runbook

Cumulative: this is the full Phase 1 system PLUS Catalog (MongoDB + Redis cache)
and Cart (Redis primary). Run from the project root in PowerShell.

## Rebuild the whole stack (now includes 5 new containers)

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml up --build -d
```

New containers you'll see alongside Phase 1: `catalog-service`, `cart-service`,
`catalog-mongo`, `catalog-redis`, `cart-redis`.

## Wait for health

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml ps
```

Re-run until all show healthy. `catalog-mongo` takes ~20s on first boot (it runs
the seed script). `catalog-service` waits for both Mongo and Redis to be healthy.

## Verify the CATALOG (public reads, cache-aside)

The seed script inserts 3 sample products. Fetch one BY SKU (first call = cache
MISS → Mongo; second call = cache HIT → Redis):

```powershell
curl.exe -sk https://api.localhost/api/catalog/products/BOOK-001
curl.exe -sk https://api.localhost/api/catalog/products/BOOK-001
```

Browse by category:

```powershell
curl.exe -sk https://api.localhost/api/catalog/categories/electronics/products
```

Prove cache invalidation — change the price, then re-fetch (next read is a fresh MISS):

```powershell
curl.exe -sk -X PATCH https://api.localhost/api/catalog/products/BOOK-001/price -H "content-type: application/json" -d '{\"priceCents\":4500}'
curl.exe -sk https://api.localhost/api/catalog/products/BOOK-001
```

You can watch hits/misses in the logs:

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.override.yml logs catalog-service
```

## Verify the CART (protected — needs a JWT)

First log in to get a token (reuse the Phase 1 user, or register again):

```powershell
curl.exe -sk -X POST https://api.localhost/api/auth/login -H "content-type: application/json" -d '{\"email\":\"test1@example.com\",\"password\":\"SuperSecret123!\"}'
```

Copy the accessToken, then add an item to the cart (replace PASTE_TOKEN):

```powershell
curl.exe -sk -X POST https://api.localhost/api/cart/items -H "content-type: application/json" -H "authorization: Bearer PASTE_TOKEN" -d '{\"sku\":\"BOOK-001\",\"quantity\":2}'
```

View the cart:

```powershell
curl.exe -sk https://api.localhost/api/cart -H "authorization: Bearer PASTE_TOKEN"
```

Confirm it's protected — call without a token (expect 401):

```powershell
curl.exe -sk -o NUL -w "HTTP %{http_code}`n" https://api.localhost/api/cart
```

## What "all good" looks like

- All containers healthy.
- Catalog get-by-sku returns a product; second call is served from cache.
- Price PATCH invalidates; next read reflects the new price.
- Cart add/view works WITH a token, returns 401 WITHOUT one.

If any step fails, capture the failing command + `logs <service>` output.
