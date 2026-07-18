// ────────────────────────────────────────────────────────────────────────────
// store.ts — Cart persistence in Redis, where Redis IS the primary datastore.
//
// KEY DATA-STRUCTURE CHOICE: we model each cart as a Redis HASH.
//   key   = cart:<userId>
//   field = <sku>
//   value = quantity
// A hash is the natural fit: a cart is a map of sku → quantity. Redis hashes let
// us increment a single item (HINCRBY), read one item, or read the whole cart
// (HGETALL) — all O(1) or O(n) over the small cart, without serialising a blob.
//
// WHY REDIS AS PRIMARY (not just cache) FOR CARTS:
//   - Carts are ephemeral session state, not permanent records. Losing an
//     abandoned cart after 24h is acceptable — even desirable.
//   - They need fast read/write on every "add to cart" click.
//   - They have a natural TTL (abandoned-cart expiry) which Redis does natively.
//   - There's no complex relational querying over carts.
// A relational DB would be overkill and slower. This is "right tool for the job".
//
// The trade-off (and the honest interview answer): Redis persistence is weaker
// than Postgres. If Redis loses data (and persistence isn't tuned), carts vanish.
// For carts that's tolerable; for orders/payments it is NOT — which is exactly
// why those services (Phase 3) use Postgres, not Redis.
// ────────────────────────────────────────────────────────────────────────────

// ioredis exposes the client as a NAMED export `Redis` (as well as a default).
// The named import is the cleanest form that constructs correctly under NodeNext.
import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => logger.error({ err }, 'redis error (PRIMARY store)'));

const keyForCart = (userId: string) => `cart:${userId}`;

export interface CartItem { sku: string; quantity: number; }

/** Add (or increment) an item, then refresh the cart's TTL (sliding expiry). */
export async function addItem(userId: string, sku: string, qty: number): Promise<void> {
  const key = keyForCart(userId);
  // HINCRBY is atomic — concurrent "add to cart" clicks won't lose updates.
  await redis.hincrby(key, sku, qty);
  // Refresh TTL on every interaction → "sliding window" expiry: the cart lives
  // as long as the user is active, expires 24h after they stop.
  await redis.expire(key, config.redis.ttlSeconds);
}

/** Set an exact quantity for an item (0 or less removes it). */
export async function setItem(userId: string, sku: string, qty: number): Promise<void> {
  const key = keyForCart(userId);
  if (qty <= 0) {
    await redis.hdel(key, sku);
  } else {
    await redis.hset(key, sku, qty);
    await redis.expire(key, config.redis.ttlSeconds);
  }
}

/** Read the whole cart as a list of items. */
export async function getCart(userId: string): Promise<CartItem[]> {
  const raw = await redis.hgetall(keyForCart(userId)); // { sku: "qty", ... }
  return Object.entries(raw).map(([sku, quantity]) => ({ sku, quantity: Number(quantity) }));
}

/** Remove a single item. */
export async function removeItem(userId: string, sku: string): Promise<void> {
  await redis.hdel(keyForCart(userId), sku);
}

/** Empty the cart entirely (e.g. after checkout). */
export async function clearCart(userId: string): Promise<void> {
  await redis.del(keyForCart(userId));
}

export async function pingRedis(): Promise<boolean> {
  try { return (await redis.ping()) === 'PONG'; } catch { return false; }
}
export async function closeRedis(): Promise<void> { await redis.quit(); }
