// ────────────────────────────────────────────────────────────────────────────
// config.ts — Catalog service configuration (12-factor; secrets via files).
//
// Same discipline as every other service: non-sensitive config from env vars,
// sensitive values (the Mongo password) from a Docker secret file via *_FILE.
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

function readSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) return readFileSync(filePath, 'utf8').trim();
  const inline = process.env[name];
  if (inline) return inline;
  throw new Error(`Missing required secret: ${name}_FILE or ${name}`);
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  serviceName: 'catalog-service',
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '3000')),
  logLevel: readEnv('LOG_LEVEL', 'info'),

  // ── MongoDB (primary store) ───────────────────────────────────────────────
  mongo: {
    host: readEnv('MONGO_HOST', 'catalog-mongo'),
    port: Number(readEnv('MONGO_PORT', '27017')),
    database: readEnv('MONGO_DB', 'catalogdb'),
    user: readEnv('MONGO_USER', 'cataloguser'),
    password: readSecret('MONGO_PASSWORD'),
  },

  // ── Redis (cache-aside layer) ─────────────────────────────────────────────
  redis: {
    host: readEnv('REDIS_HOST', 'catalog-redis'),
    port: Number(readEnv('REDIS_PORT', '6379')),
    // Cache entries expire after this many seconds. A TTL is the simplest
    // safety net against stale data: even if invalidation logic ever misses,
    // the cache self-heals within TTL. 60s is a sensible default for a catalog.
    ttlSeconds: Number(readEnv('CACHE_TTL', '60')),
  },
} as const;
