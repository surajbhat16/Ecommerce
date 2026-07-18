// ────────────────────────────────────────────────────────────────────────────
// index.ts — Order service (saga orchestrator) entrypoint.
//
// Exposes POST /orders (place an order → starts the saga) and GET /orders/:id
// (check the saga's current state). Subscribes to the inventory/payment events
// that drive the state machine, and runs the outbox relay.
// ────────────────────────────────────────────────────────────────────────────
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration } from './metrics.js';
import { pool, ping, closePool } from './db.js';
import { connectRabbit, subscribe, closeRabbit } from './rabbit.js';
import {
  createOrder, startOutboxRelay, stopOutboxRelay,
  onInventoryReserved, onInventoryRejected, onPaymentSucceeded, onPaymentFailed,
} from './saga.js';

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

// Place an order. The gateway injects x-user-id after validating the JWT.
app.post<{ Body: { items?: { sku: string; quantity: number }[] } }>('/orders', async (req, reply) => {
  const userId = req.headers['x-user-id'] as string | undefined;
  if (!userId) return reply.code(401).send({ error: 'missing user context' });
  const items = req.body?.items;
  if (!items || items.length === 0) return reply.code(400).send({ error: 'items required' });

  const { orderId } = await createOrder({ userId, items });
  // 202 Accepted: the saga runs asynchronously. Poll GET /orders/:id for state.
  return reply.code(202).send({ orderId, status: 'PENDING', servedBy: INSTANCE_ID });
});

// Check the saga's current state for an order.
app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.user_id, o.status, o.total_cents, o.created_at,
            COALESCE(json_agg(json_build_object('sku', i.sku, 'quantity', i.quantity)) , '[]') AS items
     FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id`,
    [req.params.id],
  );
  if (!rows[0]) return reply.code(404).send({ error: 'order not found' });
  return { order: rows[0], servedBy: INSTANCE_ID };
});

async function start(): Promise<void> {
  await connectRabbit();

  // Wire the saga: react to inventory + payment events.
  await subscribe('order.inventory-reserved', ['inventory.reserved'], async (_rk, e) => onInventoryReserved(e));
  await subscribe('order.inventory-rejected', ['inventory.rejected'], async (_rk, e) => onInventoryRejected(e));
  await subscribe('order.payment-succeeded', ['payment.succeeded'], async (_rk, e) => onPaymentSucceeded(e));
  await subscribe('order.payment-failed', ['payment.failed'], async (_rk, e) => onPaymentFailed(e));

  startOutboxRelay();   // begin publishing committed outbox events

  await app.listen({ host: config.host, port: config.port });
  logger.info({ port: config.port, instance: INSTANCE_ID }, 'order-service listening');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  stopOutboxRelay();
  await app.close();
  await closeRabbit();
  await closePool();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err) => { logger.error({ err }, 'failed to start'); process.exit(1); });
