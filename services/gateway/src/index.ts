// ────────────────────────────────────────────────────────────────────────────
// index.ts — API Gateway entrypoint.
//
// ROLE OF THE GATEWAY (the architecture talking point):
//   Traefik (the edge) handles TRANSPORT concerns: TLS termination, L7 load
//   balancing across gateway replicas. The GATEWAY handles APPLICATION concerns:
//     - routing to the right upstream service,
//     - coarse-grained auth (validating the JWT once, at the edge of the mesh),
//     - rate limiting,
//     - request-id propagation for tracing.
//   Keeping these two layers separate is deliberate separation of concerns.
//
// This service is STATELESS — that's what makes it safe to run N replicas behind
// Traefik. No session state lives in memory; the JWT carries identity.
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration } from './metrics.js';

const INSTANCE_ID = randomUUID().slice(0, 8); // identifies THIS gateway replica

const app = Fastify({ logger: false, trustProxy: true });

// ── Rate limiting ─────────────────────────────────────────────────────────────
// DEVOPS CONCEPT: protect upstreams from abuse / accidental floods. For Phase 1
// this is in-memory (per-replica). NOTE the limitation: with N replicas, the
// effective limit is N × max because each replica counts independently. The
// production fix is a SHARED store (Redis) so the counter is global — we add
// that in a later phase. Calling this out is itself a senior-level answer.
await app.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.windowMs,
});

// ── Request id + instance stamping ─────────────────────────────────────────────
// Attach a correlation id to every request so a single call can be traced across
// services (full distributed tracing arrives in Phase 5; this is the seam).
app.addHook('onRequest', async (req, reply) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  reply.header('x-request-id', requestId);
  reply.header('x-served-by-gateway', INSTANCE_ID); // SEE load balancing in action
});

// ── Health endpoints (same liveness/readiness split as every service) ──────────
app.get('/health/live', async () => ({ status: 'alive', instance: INSTANCE_ID }));
app.get('/health/ready', async () => {
  // The gateway has no hard dependency that must be up to accept connections;
  // readiness here just confirms the process can serve. (We could ping upstreams,
  // but that would couple gateway readiness to every backend — undesirable.)
  return { status: 'ready', instance: INSTANCE_ID };
});
// ── Prometheus metrics (Phase 5) ─────────────────────────────────────────────
// R.E.D. histogram on every response. /metrics and health probes are excluded:
// scraping the scraper and liveness noise would pollute rate() queries.
app.addHook('onResponse', async (req, reply) => {
  const route = req.routeOptions?.url ?? req.url;
  if (route === '/metrics' || route.startsWith('/health')) return;
  httpRequestDuration
    .labels(req.method, route, String(reply.statusCode))
    .observe(reply.elapsedTime / 1000);
});
app.get('/metrics', async (_req, reply) => {
  reply.header('content-type', registry.contentType);
  return registry.metrics();
});

// ── JWT validation hook for PROTECTED routes ───────────────────────────────────
// We validate the token ONCE at the gateway. Downstream services can then trust
// the forwarded identity header rather than each re-validating (a common pattern;
// the trade-off vs. zero-trust per-service validation is discussed in the README).
async function requireAuth(req: any, reply: any): Promise<void> {
  const header = req.headers['authorization'] as string | undefined;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'missing bearer token' });
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, config.jwt.signingKey, {
      issuer: config.jwt.issuer,
    }) as any;
    // Propagate identity to upstreams as a header.
    req.headers['x-user-id'] = payload.sub;
  } catch {
    return reply.code(401).send({ error: 'invalid or expired token' });
  }
}

// ── Routing / proxying to upstreams ────────────────────────────────────────────
// PUBLIC auth routes (register/login) are proxied WITHOUT requiring a token.
// We expose them under /api/auth/* and strip that prefix before forwarding.
await app.register(proxy, {
  upstream: config.upstreams.auth,
  prefix: '/api/auth',         // public-facing path
  rewritePrefix: '',           // auth-service serves /register, /login at root
  http2: false,
});

// ── PHASE 2: Catalog — PUBLIC reads (browse the shop without logging in). ───────
// No auth required. Proxied to the catalog service, prefix stripped.
await app.register(proxy, {
  upstream: config.upstreams.catalog,
  prefix: '/api/catalog',
  rewritePrefix: '',
  http2: false,
});

// ── PHASE 2: Cart — PROTECTED (a cart belongs to a logged-in user). ─────────────
// We register the JWT preHandler, which validates the token and injects
// x-user-id, THEN proxy to the cart service. The cart service trusts x-user-id.
await app.register(async (instance) => {
  instance.addHook('preHandler', requireAuth);
  await instance.register(proxy, {
    upstream: config.upstreams.cart,
    prefix: '/api/cart',
    rewritePrefix: '/cart',   // cart service serves routes under /cart
    http2: false,
    // Forward the x-user-id header the auth hook set onto the upstream request.
    replyOptions: {
      rewriteRequestHeaders: (req: any, headers: any) => ({
        ...headers,
        'x-user-id': req.headers['x-user-id'],
      }),
    },
  });
});

// ── PHASE 3: Orders — PROTECTED (placing/viewing orders needs a logged-in user).
await app.register(async (instance) => {
  instance.addHook('preHandler', requireAuth);
  await instance.register(proxy, {
    upstream: config.upstreams.order,
    prefix: '/api/orders',
    rewritePrefix: '/orders',
    http2: false,
    replyOptions: {
      rewriteRequestHeaders: (req: any, headers: any) => ({
        ...headers,
        'x-user-id': req.headers['x-user-id'],
      }),
    },
  });
});

// Protected seam from Phase 1 (kept): /api/secure/* requires a valid JWT.
app.register(async (instance) => {
  instance.addHook('preHandler', requireAuth);
  instance.get('/api/secure/whoami', async (req: any) => ({
    userId: req.headers['x-user-id'],
    servedByGateway: INSTANCE_ID,
  }));
});

async function start(): Promise<void> {
  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info({ port: config.port, instance: INSTANCE_ID }, 'api-gateway listening');
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}

// Graceful shutdown — same rationale as the auth service.
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
