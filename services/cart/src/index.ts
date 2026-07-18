// ────────────────────────────────────────────────────────────────────────────
// index.ts — Cart service HTTP entrypoint.
//
// A cart belongs to a user, so every route is user-scoped. The gateway validates
// the JWT and forwards the user id as the `x-user-id` header; this service trusts
// that header (the "validate once at the edge" pattern established in Phase 1).
// If the header is absent, we reject — defense in case the route is hit directly.
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration } from './metrics.js';
import {
  addItem, setItem, getCart, removeItem, clearCart, pingRedis, closeRedis,
} from './store.js';

const INSTANCE_ID = randomUUID().slice(0, 8);
const app = Fastify({ logger: false, trustProxy: true });

// Extract the user id the gateway injected. Reject if missing.
function userId(req: any, reply: any): string | null {
  const uid = req.headers['x-user-id'] as string | undefined;
  if (!uid) {
    reply.code(401).send({ error: 'missing user context (x-user-id)' });
    return null;
  }
  return uid;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health/live', async () => ({ status: 'alive', instance: INSTANCE_ID }));
app.get('/health/ready', async (_req, reply) => {
  // Redis is the PRIMARY store here, so if it's down the service genuinely
  // cannot serve — readiness MUST fail (unlike catalog, where Redis is optional).
  const ok = await pingRedis();
  if (!ok) return reply.code(503).send({ status: 'not-ready', redis: 'down', instance: INSTANCE_ID });
  return { status: 'ready', redis: 'up', instance: INSTANCE_ID };
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

// ── Cart endpoints ──────────────────────────────────────────────────────────────
app.get('/cart', async (req, reply) => {
  const uid = userId(req, reply); if (!uid) return;
  const items = await getCart(uid);
  return { userId: uid, items, servedBy: INSTANCE_ID };
});

app.post<{ Body: { sku?: string; quantity?: number } }>('/cart/items', async (req, reply) => {
  const uid = userId(req, reply); if (!uid) return;
  const { sku, quantity } = req.body ?? {};
  if (!sku || !quantity || quantity < 1) {
    return reply.code(400).send({ error: 'sku and positive quantity required' });
  }
  await addItem(uid, sku, quantity);
  logger.info({ uid, sku, quantity }, 'item added to cart');
  return reply.code(201).send({ userId: uid, items: await getCart(uid), servedBy: INSTANCE_ID });
});

app.put<{ Params: { sku: string }; Body: { quantity?: number } }>(
  '/cart/items/:sku',
  async (req, reply) => {
    const uid = userId(req, reply); if (!uid) return;
    const { quantity } = req.body ?? {};
    if (quantity == null) return reply.code(400).send({ error: 'quantity required' });
    await setItem(uid, req.params.sku, quantity);
    return { userId: uid, items: await getCart(uid), servedBy: INSTANCE_ID };
  },
);

app.delete<{ Params: { sku: string } }>('/cart/items/:sku', async (req, reply) => {
  const uid = userId(req, reply); if (!uid) return;
  await removeItem(uid, req.params.sku);
  return { userId: uid, items: await getCart(uid), servedBy: INSTANCE_ID };
});

app.delete('/cart', async (req, reply) => {
  const uid = userId(req, reply); if (!uid) return;
  await clearCart(uid);
  return { userId: uid, items: [], servedBy: INSTANCE_ID };
});

// ── Startup + shutdown ──────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info({ port: config.port, instance: INSTANCE_ID }, 'cart-service listening');
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  await app.close();
  await closeRedis();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
