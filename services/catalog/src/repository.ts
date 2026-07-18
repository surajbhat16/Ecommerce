// ────────────────────────────────────────────────────────────────────────────
// repository.ts — Product data access implementing the CACHE-ASIDE pattern.
//
// CACHE-ASIDE (a.k.a. lazy-loading) is the most common caching strategy. The
// application — not the cache — owns the logic. The flow for a READ:
//
//   1. Look in the cache (Redis) first.
//   2. HIT  → return the cached value. (Fast path; Mongo untouched.)
//   3. MISS → read from the source of truth (Mongo), then WRITE it into the
//             cache with a TTL, then return it. Next read for this key is a hit.
//
// For a WRITE (create/update/delete), we write to Mongo (the source of truth)
// and then INVALIDATE the cache entry so the next read re-populates fresh data.
//
// WHY invalidate rather than update-the-cache-too ("write-through")? Because
// invalidation is simpler and safer: a stale cache entry is the classic bug, and
// deleting the key guarantees the next read reflects Mongo. The trade-off is one
// extra cache miss after each write. We discuss alternatives in docs/CONCEPTS.md.
// ────────────────────────────────────────────────────────────────────────────

import { products, type Product } from './mongo.js';
import { redis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Cache key design: namespace keys so they never collide with other data in the
// same Redis instance and are easy to reason about / bulk-invalidate.
const keyForSku = (sku: string) => `catalog:product:${sku}`;
const keyForCategory = (category: string) => `catalog:category:${category}`;

/**
 * Get a single product by SKU — the canonical cache-aside read.
 * Returns the product or null if it doesn't exist.
 */
export async function getProductBySku(sku: string): Promise<Product | null> {
  const cacheKey = keyForSku(sku);

  // 1. Try the cache first.
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug({ sku }, 'cache HIT');
      return JSON.parse(cached) as Product;
    }
  } catch (err) {
    // Cache read failed — log and fall through to Mongo. Degraded, not broken.
    logger.warn({ err, sku }, 'cache read failed; falling back to Mongo');
  }

  logger.debug({ sku }, 'cache MISS');

  // 2. Cache miss → read the source of truth.
  const product = await products().findOne({ sku });
  if (!product) return null;

  // 3. Populate the cache for next time, with a TTL (SET key value EX seconds).
  //    We do this best-effort — if the cache write fails, we still return data.
  try {
    await redis.set(cacheKey, JSON.stringify(product), 'EX', config.redis.ttlSeconds);
  } catch (err) {
    logger.warn({ err, sku }, 'cache populate failed');
  }

  return product;
}

/**
 * List products in a category — also cache-aside, but the cached value is a
 * whole list. Demonstrates caching collection results, not just single docs.
 */
export async function listByCategory(category: string): Promise<Product[]> {
  const cacheKey = keyForCategory(category);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug({ category }, 'category cache HIT');
      return JSON.parse(cached) as Product[];
    }
  } catch (err) {
    logger.warn({ err, category }, 'category cache read failed');
  }

  const list = await products().find({ category }).limit(100).toArray();
  try {
    await redis.set(cacheKey, JSON.stringify(list), 'EX', config.redis.ttlSeconds);
  } catch (err) {
    logger.warn({ err, category }, 'category cache populate failed');
  }
  return list;
}

/**
 * Create a product — WRITE path. Write to Mongo, then invalidate any cache
 * entries that could now be stale (the category list this product belongs to).
 */
export async function createProduct(input: Omit<Product, 'createdAt'>): Promise<Product> {
  const doc: Product = { ...input, createdAt: new Date() };
  await products().insertOne(doc);

  // Invalidate the category list cache so the new product shows up on next read.
  // (The single-product key doesn't exist yet, so nothing to invalidate there.)
  await invalidate(keyForCategory(input.category));
  logger.info({ sku: input.sku }, 'product created; category cache invalidated');
  return doc;
}

/**
 * Update a product's price — WRITE path. Update Mongo, then invalidate BOTH the
 * single-product key AND its category list (both could now be stale).
 */
export async function updatePrice(sku: string, priceCents: number): Promise<Product | null> {
  const result = await products().findOneAndUpdate(
    { sku },
    { $set: { priceCents } },
    { returnDocument: 'after' },
  );
  if (!result) return null;

  await invalidate(keyForSku(sku), keyForCategory(result.category));
  logger.info({ sku }, 'price updated; caches invalidated');
  return result;
}

/** Delete cache keys, best-effort. Invalidation must never crash a write. */
async function invalidate(...keys: string[]): Promise<void> {
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err, keys }, 'cache invalidation failed');
  }
}
