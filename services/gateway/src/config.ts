// ────────────────────────────────────────────────────────────────────────────
// config.ts — Gateway configuration (12-factor; secrets via files).
//
// The gateway needs the SAME JWT signing key as the auth service to VALIDATE
// tokens auth issued. That key is a Docker secret, read from a file — never an
// env var. (Symmetric HS256 here for simplicity; a real system might use RS256
// so the gateway only needs the public key. We note that trade-off in the README.)
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
  serviceName: 'api-gateway',
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '8080')),
  logLevel: readEnv('LOG_LEVEL', 'info'),

  // Upstream service addresses. These are Docker DNS names on the `backend`
  // network — Docker's embedded DNS resolves `auth-service` to the container(s).
  // When auth-service is scaled, Docker's DNS round-robins; for HTTP keep-alive
  // we rely on Traefik for auth LB, but service-to-service uses these names.
  upstreams: {
    auth: readEnv('AUTH_UPSTREAM', 'http://auth-service:3000'),
    catalog: readEnv('CATALOG_UPSTREAM', 'http://catalog-service:3000'),
    cart: readEnv('CART_UPSTREAM', 'http://cart-service:3000'),
    order: readEnv('ORDER_UPSTREAM', 'http://order-service:3000'),
  },

  jwt: {
    signingKey: readSecret('JWT_SIGNING_KEY'),
    issuer: readEnv('JWT_ISSUER', 'ecommerce-auth'),
  },

  rateLimit: {
    max: Number(readEnv('RATE_LIMIT_MAX', '100')),          // requests
    windowMs: Number(readEnv('RATE_LIMIT_WINDOW_MS', '60000')), // per minute
  },
} as const;
