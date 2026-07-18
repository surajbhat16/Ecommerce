// ────────────────────────────────────────────────────────────────────────────
// index.ts — Inventory service.
//
// Its role in the SAGA: when the Order service emits `order.created`, inventory
// tries to RESERVE stock. It emits `inventory.reserved` (success) or
// `inventory.rejected` (out of stock). If a later saga step fails, it consumes
// `inventory.release` (a COMPENSATING action) and returns the reserved units.
//
// IDEMPOTENCY: every reservation is keyed by orderId and recorded, so a
// redelivered `order.created` (at-least-once delivery) does not double-reserve.
// ────────────────────────────────────────────────────────────────────────────
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration, reservationsTotal } from './metrics.js';
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

// Read-only endpoint to inspect stock (handy for demos).
app.get('/stock', async () => {
  const { rows } = await pool.query('SELECT sku, available, reserved FROM stock ORDER BY sku');
  return { stock: rows, servedBy: INSTANCE_ID };
});

interface OrderCreated {
  orderId: string;
  items: { sku: string; quantity: number }[];
}

/**
 * Reserve stock for an order, ATOMICALLY and IDEMPOTENTLY.
 * Uses a single DB transaction:
 *   1. If this order was already processed → return the recorded outcome (idempotent).
 *   2. Try to decrement available / increment reserved for every line.
 *   3. If any line lacks stock → roll back, record 'rejected'.
 *   4. Otherwise commit, record 'reserved'.
 */
async function reserveForOrder(evt: OrderCreated): Promise<'reserved' | 'rejected'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check — has this order already been handled?
    const seen = await client.query<{ outcome: string }>(
      'SELECT outcome FROM processed_reservations WHERE order_id = $1',
      [evt.orderId],
    );
    if (seen.rows[0]) {
      await client.query('COMMIT');
      logger.info({ orderId: evt.orderId }, 'duplicate order.created — idempotent no-op');
      return seen.rows[0].outcome as 'reserved' | 'rejected';
    }

    // Try to reserve every line. `available >= qty` in the WHERE clause makes the
    // update atomic: it only succeeds if there's enough stock, no race window.
    let ok = true;
    for (const line of evt.items) {
      const res = await client.query(
        `UPDATE stock SET available = available - $2, reserved = reserved + $2
         WHERE sku = $1 AND available >= $2`,
        [line.sku, line.quantity],
      );
      if (res.rowCount === 0) { ok = false; break; }
    }

    const outcome: 'reserved' | 'rejected' = ok ? 'reserved' : 'rejected';
    reservationsTotal.labels(outcome).inc();
    if (!ok) {
      await client.query('ROLLBACK');            // undo any partial reservations
      await client.query('BEGIN');               // new tx just to record the outcome
    }
    await client.query(
      'INSERT INTO processed_reservations (order_id, outcome) VALUES ($1, $2)',
      [evt.orderId, outcome],
    );
    await client.query('COMMIT');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Release previously reserved stock — the COMPENSATING action. */
async function releaseForOrder(evt: OrderCreated): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const line of evt.items) {
      await client.query(
        `UPDATE stock SET available = available + $2, reserved = reserved - $2
         WHERE sku = $1`,
        [line.sku, line.quantity],
      );
    }
    await client.query('COMMIT');
    logger.info({ orderId: evt.orderId }, 'inventory released (compensation)');
    reservationsTotal.labels('released').inc();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function start(): Promise<void> {
  await connectRabbit();

  // Consume order.created → reserve → emit reserved/rejected.
  await subscribe('inventory.order-created', ['order.created'], async (_rk, evt: OrderCreated) => {
    const outcome = await reserveForOrder(evt);
    if (outcome === 'reserved') {
      publish('inventory.reserved', { orderId: evt.orderId, items: evt.items });
    } else {
      publish('inventory.rejected', { orderId: evt.orderId, reason: 'out_of_stock' });
    }
  });

  // Consume inventory.release (compensation triggered by a later saga failure).
  await subscribe('inventory.release', ['inventory.release'], async (_rk, evt: OrderCreated) => {
    await releaseForOrder(evt);
  });

  await app.listen({ host: config.host, port: config.port });
  logger.info({ port: config.port, instance: INSTANCE_ID }, 'inventory-service listening');
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
