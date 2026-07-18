// ────────────────────────────────────────────────────────────────────────────
// index.ts — Catalog service HTTP entrypoint.
//
// Read endpoints are public (browse the shop without logging in). Write
// endpoints exist for seeding/admin; in a real system they'd be admin-protected.
// Same health/metrics/shutdown patterns as every other service.
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration } from './metrics.js';
import { connectMongo, pingMongo, closeMongo } from './mongo.js';
import { pingRedis, closeRedis } from './redis.js';
import {
  getProductBySku,
  listByCategory,
  createProduct,
  updatePrice,
} from './repository.js';

const INSTANCE_ID = randomUUID().slice(0, 8);
const app = Fastify({ logger: false, trustProxy: true });

// ── Health ────────────────────────────────────────────────────────────────────
// Liveness: cheap, no dependencies (must not restart-storm on a DB blip).
app.get('/health/live', async () => ({ status: 'alive', instance: INSTANCE_ID }));

// Readiness: Mongo (the source of truth) MUST be up to serve. Redis is optional
// — the service degrades gracefully without it — so readiness does NOT fail if
// only the cache is down. This is a deliberate, defensible distinction.
app.get('/health/ready', async (_req, reply) => {
  const mongoOk = await pingMongo();
  const redisOk = await pingRedis();
  if (!mongoOk) {
    return reply.code(503).send({ status: 'not-ready', mongo: 'down', instance: INSTANCE_ID });
  }
  return { status: 'ready', mongo: 'up', redis: redisOk ? 'up' : 'down (degraded)', instance: INSTANCE_ID };
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

// ── Read endpoints (cache-aside) ────────────────────────────────────────────────
app.get<{ Params: { sku: string } }>('/products/:sku', async (req, reply) => {
  const product = await getProductBySku(req.params.sku);
  if (!product) return reply.code(404).send({ error: 'product not found' });
  return { product, servedBy: INSTANCE_ID };
});

app.get<{ Params: { category: string } }>('/categories/:category/products', async (req) => {
  const list = await listByCategory(req.params.category);
  return { products: list, count: list.length, servedBy: INSTANCE_ID };
});

// ── Write endpoints (write to Mongo + invalidate cache) ──────────────────────────
app.post<{ Body: Partial<Parameters<typeof createProduct>[0]> }>('/products', async (req, reply) => {
  const b = req.body ?? {};
  if (!b.sku || !b.name || b.priceCents == null || !b.category) {
    return reply.code(400).send({ error: 'sku, name, priceCents, category are required' });
  }
  try {
    const product = await createProduct({
      sku: b.sku,
      name: b.name,
      description: b.description ?? '',
      category: b.category,
      priceCents: b.priceCents,
      currency: b.currency ?? 'USD',
      attributes: b.attributes ?? {},
    });
    return reply.code(201).send({ product, servedBy: INSTANCE_ID });
  } catch (err: any) {
    if (err?.code === 11000) {
      // Mongo duplicate-key error (unique index on sku).
      return reply.code(409).send({ error: 'sku already exists' });
    }
    logger.error({ err }, 'create product failed');
    return reply.code(500).send({ error: 'internal error' });
  }
});

app.patch<{ Params: { sku: string }; Body: { priceCents?: number } }>(
  '/products/:sku/price',
  async (req, reply) => {
    const { priceCents } = req.body ?? {};
    if (priceCents == null) return reply.code(400).send({ error: 'priceCents required' });
    const updated = await updatePrice(req.params.sku, priceCents);
    if (!updated) return reply.code(404).send({ error: 'product not found' });
    return { product: updated, servedBy: INSTANCE_ID };
  },
);

// ── Startup + graceful shutdown ──────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await connectMongo(); // connect + ensure indexes before accepting traffic
    await app.listen({ host: config.host, port: config.port });
    logger.info({ port: config.port, instance: INSTANCE_ID }, 'catalog-service listening');
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  await app.close();
  await closeMongo();
  await closeRedis();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
