// ────────────────────────────────────────────────────────────────────────────
// index.ts — Payment service.
//
// Role in the SAGA: consumes `inventory.reserved` (stock is secured), attempts a
// charge, and emits `payment.succeeded` or `payment.failed`.
//
// DETERMINISTIC FAILURE: any order containing config.failOnSku always fails, so
// the compensation path is demoable on demand.
//
// IDEMPOTENCY KEY: the order id is the idempotency key. A UNIQUE constraint on it
// means a redelivered charge request cannot double-charge — we detect the conflict
// and return the original outcome.
// ────────────────────────────────────────────────────────────────────────────
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration, paymentsTotal } from './metrics.js';
import { pool, ping, closePool } from './db.js';
import { connectRabbit, subscribe, publish, closeRabbit } from './rabbit.js';

const INSTANCE_ID = randomUUID().slice(0, 8);
const app = Fastify({ logger: false, trustProxy: true });

app.get('/health/live', async () => ({ status: 'alive', instance: INSTANCE_ID }));
app.get('/health/ready', async (_req, reply) => {
  const dbOk = await ping();
  if (!dbOk) return reply.code(503).send({ status: 'not-ready', db: 'down' });
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

interface InventoryReserved {
  orderId: string;
  items: { sku: string; quantity: number }[];
}

/**
 * Charge for an order, idempotently and deterministically.
 * Returns 'succeeded' | 'failed'.
 */
async function charge(evt: InventoryReserved): Promise<'succeeded' | 'failed'> {
  // Idempotency: if we already have a payment row for this order, return it.
  const existing = await pool.query<{ status: string }>(
    'SELECT status FROM payments WHERE idempotency_key = $1',
    [evt.orderId],
  );
  if (existing.rows[0]) {
    logger.info({ orderId: evt.orderId }, 'duplicate charge — idempotent, returning prior result');
    return existing.rows[0].status as 'succeeded' | 'failed';
  }

  // DETERMINISTIC failure rule: fail if any line is the configured "fail" SKU.
  const willFail = evt.items.some((i) => i.sku === config.failOnSku);
  const status: 'succeeded' | 'failed' = willFail ? 'failed' : 'succeeded';

  // A trivial "amount" derived from quantity — real payment would call a PSP.
  const amountCents = evt.items.reduce((sum, i) => sum + i.quantity * 1000, 0);

  try {
    await pool.query(
      'INSERT INTO payments (idempotency_key, amount_cents, status) VALUES ($1, $2, $3)',
      [evt.orderId, amountCents, status],
    );
  } catch (err: any) {
    // 23505 = unique_violation → a concurrent duplicate won the race; re-read.
    if (err?.code === '23505') {
      const row = await pool.query<{ status: string }>(
        'SELECT status FROM payments WHERE idempotency_key = $1', [evt.orderId],
      );
      return (row.rows[0]?.status as 'succeeded' | 'failed') ?? 'failed';
    }
    throw err;
  }

  logger.info({ orderId: evt.orderId, status }, 'charge processed');
  return status;
}

async function start(): Promise<void> {
  await connectRabbit();

  await subscribe('payment.inventory-reserved', ['inventory.reserved'], async (_rk, evt: InventoryReserved) => {
    const result = await charge(evt);
    if (result === 'succeeded') {
      publish('payment.succeeded', { orderId: evt.orderId });
      paymentsTotal.labels('succeeded').inc();
    } else {
      // On failure, we emit payment.failed. The Order orchestrator will then
      // trigger the compensating inventory.release.
      publish('payment.failed', { orderId: evt.orderId, items: evt.items, reason: 'declined' });
      paymentsTotal.labels('failed').inc();
    }
  });

  await app.listen({ host: config.host, port: config.port });
  logger.info({ port: config.port, instance: INSTANCE_ID, failOnSku: config.failOnSku }, 'payment-service listening');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  await app.close();
  await closeRabbit();
  await closePool();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err) => { logger.error({ err }, 'failed to start'); process.exit(1); });
