// ────────────────────────────────────────────────────────────────────────────
// redis.ts — Redis client for the cache-aside layer.
//
// Here Redis is a CACHE, not the source of truth (contrast the Cart service,
// where Redis IS the primary datastore). MongoDB holds the authoritative product
// data; Redis holds short-lived copies to serve reads faster and offload Mongo.
// ────────────────────────────────────────────────────────────────────────────

// ioredis exposes the client as a NAMED export `Redis` (as well as a default).
// The named import is the cleanest form that constructs correctly under NodeNext.
import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  // Fail fast rather than hang if Redis is unreachable — the cache is optional,
  // so we degrade to hitting Mongo directly rather than blocking requests.
  maxRetriesPerRequest: 2,
  lazyConnect: false,
});

redis.on('error', (err: Error) => {
  // A cache error must NOT crash the service — log it and carry on. The whole
  // point of cache-aside is that the app still works (slower) if the cache dies.
  logger.warn({ err }, 'redis error (cache) — continuing without cache');
});

/** Readiness ping for the cache. */
export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
