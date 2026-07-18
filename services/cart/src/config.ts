// ────────────────────────────────────────────────────────────────────────────
// config.ts — Cart service configuration.
//
// Cart has NO password secret in this phase because the local Redis runs without
// auth on an internal-only network (nothing outside can reach it). In production
// you'd add a Redis password as a Docker secret — the seam is the same *_FILE
// pattern used elsewhere. We note this explicitly so the choice is deliberate.
// ────────────────────────────────────────────────────────────────────────────

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  serviceName: 'cart-service',
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '3000')),
  logLevel: readEnv('LOG_LEVEL', 'info'),
  redis: {
    host: readEnv('REDIS_HOST', 'cart-redis'),
    port: Number(readEnv('REDIS_PORT', '6379')),
    // Carts expire after inactivity. Because Redis is the PRIMARY store here,
    // this TTL is a business rule (abandoned-cart expiry), not a cache detail.
    ttlSeconds: Number(readEnv('CART_TTL', '86400')), // 24h
  },
} as const;
