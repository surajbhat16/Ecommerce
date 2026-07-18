// ────────────────────────────────────────────────────────────────────────────
// saga.ts — The ORCHESTRATION saga + the TRANSACTIONAL OUTBOX relay.
//
// The Order service is the conductor. It creates the order, then reacts to events
// from inventory and payment, advancing (or compensating) the order's state.
//
// State machine:
//   createOrder → order PENDING, outbox: order.created
//   inventory.reserved  → order AWAITING_PAYMENT   (payment will proceed)
//   inventory.rejected  → order REJECTED           (terminal: no stock)
//   payment.succeeded   → order CONFIRMED          (terminal: success)
//   payment.failed      → outbox: inventory.release, order FAILED (terminal)
// ────────────────────────────────────────────────────────────────────────────
import { pool } from './db.js';
import { logger } from './logger.js';
import { ordersTerminalTotal } from './metrics.js';
import { publish } from './rabbit.js';
import { config } from './config.js';

export interface NewOrderInput {
  userId: string;
  items: { sku: string; quantity: number }[];
}

/**
 * Create an order AND enqueue its `order.created` event in the SAME transaction
 * (the outbox pattern). Order row + outbox row commit atomically, so the event
 * can never be lost relative to the order's existence.
 */
export async function createOrder(input: NewOrderInput): Promise<{ orderId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const totalCents = input.items.reduce((s, i) => s + i.quantity * 1000, 0);
    const orderRes = await client.query<{ id: string }>(
      'INSERT INTO orders (user_id, status, total_cents) VALUES ($1, $2, $3) RETURNING id',
      [input.userId, 'PENDING', totalCents],
    );
    const orderId = orderRes.rows[0]!.id;

    for (const line of input.items) {
      await client.query(
        'INSERT INTO order_items (order_id, sku, quantity) VALUES ($1, $2, $3)',
        [orderId, line.sku, line.quantity],
      );
    }

    // Same-transaction outbox insert — this is the whole point of the pattern.
    // The payload carries userId so downstream consumers (e.g. notifications)
    // can attribute the order WITHOUT calling back into this service —
    // event-carried state transfer. Adding a field is backward-compatible:
    // existing consumers simply ignore it.
    await client.query(
      'INSERT INTO outbox (routing_key, payload) VALUES ($1, $2)',
      ['order.created', JSON.stringify({ orderId, userId: input.userId, items: input.items })],
    );

    await client.query('COMMIT');
    logger.info({ orderId }, 'order created (PENDING) + outbox enqueued');
    return { orderId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Advance order status. Also used by compensation paths. */
async function setStatus(orderId: string, status: string): Promise<void> {
  await pool.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [orderId, status]);
  logger.info({ orderId, status }, 'order status updated');
}

/** Enqueue a compensating event via the outbox (atomic with the status change). */
async function enqueueCompensation(orderId: string, routingKey: string, payload: unknown): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [orderId, 'FAILED']);
    ordersTerminalTotal.labels('FAILED').inc();
    await client.query('INSERT INTO outbox (routing_key, payload) VALUES ($1, $2)', [routingKey, JSON.stringify(payload)]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Saga event handlers ─────────────────────────────────────────────────────────
export async function onInventoryReserved(evt: { orderId: string }): Promise<void> {
  await setStatus(evt.orderId, 'AWAITING_PAYMENT');
}
export async function onInventoryRejected(evt: { orderId: string }): Promise<void> {
  await setStatus(evt.orderId, 'REJECTED');
  ordersTerminalTotal.labels('REJECTED').inc();
}
export async function onPaymentSucceeded(evt: { orderId: string }): Promise<void> {
  await setStatus(evt.orderId, 'CONFIRMED');
  ordersTerminalTotal.labels('CONFIRMED').inc();
}
export async function onPaymentFailed(evt: { orderId: string; items: any[] }): Promise<void> {
  // COMPENSATION: payment failed after stock was reserved → release the stock and
  // mark the order FAILED. The release event goes through the outbox (atomic).
  await enqueueCompensation(evt.orderId, 'inventory.release', { orderId: evt.orderId, items: evt.items });
  logger.info({ orderId: evt.orderId }, 'payment failed → compensation enqueued (FAILED)');
}

// ── THE OUTBOX RELAY ────────────────────────────────────────────────────────────
// A background loop that polls for unpublished outbox rows, publishes each to
// RabbitMQ, and marks it published. This is what actually gets events onto the
// broker after they were committed transactionally.
//
// It's AT-LEAST-ONCE: if we publish then crash before marking published, the row
// is republished next tick — which is exactly why every consumer is idempotent.
let relayTimer: NodeJS.Timeout | undefined;
export function startOutboxRelay(): void {
  const tick = async (): Promise<void> => {
    try {
      const { rows } = await pool.query<{ id: string; routing_key: string; payload: any }>(
        'SELECT id, routing_key, payload FROM outbox WHERE published = FALSE ORDER BY created_at LIMIT 20',
      );
      for (const row of rows) {
        publish(row.routing_key, row.payload);
        await pool.query('UPDATE outbox SET published = TRUE WHERE id = $1', [row.id]);
      }
    } catch (err) {
      logger.error({ err }, 'outbox relay tick failed');
    } finally {
      relayTimer = setTimeout(() => void tick(), config.outboxPollMs);
    }
  };
  void tick();
  logger.info('outbox relay started');
}
export function stopOutboxRelay(): void { if (relayTimer) clearTimeout(relayTimer); }
