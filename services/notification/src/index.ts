// ────────────────────────────────────────────────────────────────────────────
// index.ts — Notification service: a PURE event consumer (Phase 4).
//
// WHAT THIS PHASE DEMONSTRATES — PUB/SUB FAN-OUT:
//   The saga services already consume order/payment/inventory events. This
//   service binds its OWN durable queue to the SAME topic exchange with the
//   SAME routing keys. RabbitMQ delivers a COPY of each matching event to
//   every bound queue. Producers did not change at all — that's the point:
//   an exchange decouples "who publishes" from "how many consume".
//
//   Queue semantics recap:
//     - one queue, N consumers  → COMPETING CONSUMERS (each msg to ONE of them)
//     - N queues, one exchange  → FAN-OUT (each msg copied to EVERY queue)
//   This service is the second case relative to the saga services.
//
// EVENT-CARRIED STATE TRANSFER:
//   payment.succeeded / payment.failed events carry only { orderId, ... } —
//   they don't know the user. Instead of calling the order service (which
//   would re-couple us synchronously), we LEARN orderId → user context from
//   order.created and keep it in a small local map. State travels in events;
//   consumers build the slice of state they need.
//
// DELIVERY & DUPLICATES:
//   Delivery is at-least-once, so a redelivered event could produce a
//   duplicate email. For a money mutation that would be unacceptable (hence
//   the processed-events table in inventory); for a notification, a bounded
//   in-memory dedupe of (routingKey, orderId) is a proportionate answer —
//   worst case after a restart is one repeated email, which is harmless.
//   Choosing idempotency strength per consumer IS the senior skill.
// ────────────────────────────────────────────────────────────────────────────
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration, notificationsSentTotal } from './metrics.js';
import { connectRabbit, subscribe, closeRabbit, getChannel } from './rabbit.js';

const INSTANCE_ID = randomUUID().slice(0, 8);
const app = Fastify({ logger: false, trustProxy: true });

// ── Consumer-local state (all bounded, all rebuildable from the stream) ──────
// orderId → context learned from order.created (event-carried state transfer).
const orderContext = new Map<string, { userId?: string; items: { sku: string; quantity: number }[] }>();
// Dedupe of already-notified (routingKey, orderId) pairs — at-least-once guard.
const seen = new Set<string>();
// Ring buffer of "sent" notifications for the demo endpoint.
interface SentNotification {
  at: string;
  channel: 'email';
  to: string;
  subject: string;
  event: string;
  orderId: string;
}
const history: SentNotification[] = [];

const MAX_TRACKED = 1000;
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value as K; // Maps iterate in insertion order
    map.delete(oldest);
  }
}
function dedupeKey(routingKey: string, orderId: string): string {
  return `${routingKey}:${orderId}`;
}

/** "Send" a notification: structured log + ring buffer. A real implementation
 *  would call an email/SMS/push provider here — the consumption pattern around
 *  it (queue, ack, dedupe) would be identical. */
function send(event: string, orderId: string, subject: string): void {
  const ctx = orderContext.get(orderId);
  const to = ctx?.userId ? `user:${ctx.userId}` : 'user:unknown';
  const note: SentNotification = {
    at: new Date().toISOString(),
    channel: 'email',
    to,
    subject,
    event,
    orderId,
  };
  history.push(note);
  if (history.length > config.historySize) history.shift();
  logger.info({ ...note }, 'NOTIFICATION sent (simulated)');
  notificationsSentTotal.labels(event).inc();
}

// ── HTTP surface: health + a read-only demo endpoint ─────────────────────────
app.get('/health/live', async () => ({ status: 'alive', instance: INSTANCE_ID }));
app.get('/health/ready', async (_req, reply) => {
  // Ready = we hold an open channel to the broker. No DB to check.
  const ch = getChannel();
  if (!ch) return reply.code(503).send({ status: 'not-ready', rabbit: 'down' });
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
// Demo visibility: what has been "sent"? (Debug port only; not routed via gateway.)
app.get('/notifications', async () => ({
  count: history.length,
  notifications: [...history].reverse(),
  servedBy: INSTANCE_ID,
}));

// ── Event handlers ────────────────────────────────────────────────────────────
interface OrderEvent {
  orderId: string;
  userId?: string;
  items?: { sku: string; quantity: number }[];
  reason?: string;
}

async function onEvent(routingKey: string, evt: OrderEvent): Promise<void> {
  // Learn context first — even a duplicate order.created should refresh it.
  if (routingKey === 'order.created') {
    remember(orderContext, evt.orderId, { userId: evt.userId, items: evt.items ?? [] });
  }

  // At-least-once guard: skip if we've already notified for this (event, order).
  const key = dedupeKey(routingKey, evt.orderId);
  if (seen.has(key)) {
    logger.info({ routingKey, orderId: evt.orderId }, 'duplicate event — notification suppressed');
    return;
  }

  switch (routingKey) {
    case 'order.created':
      send(routingKey, evt.orderId, 'We received your order');
      break;
    case 'payment.succeeded':
      send(routingKey, evt.orderId, 'Your order is confirmed');
      break;
    case 'payment.failed':
      send(routingKey, evt.orderId, 'Payment failed — your order was cancelled');
      break;
    case 'inventory.rejected':
      send(routingKey, evt.orderId, 'Sorry — an item in your order is out of stock');
      break;
    default:
      logger.warn({ routingKey }, 'unhandled event type');
      return; // don't mark unknown events as seen
  }

  seen.add(key);
  if (seen.size > MAX_TRACKED) {
    const oldest = seen.values().next().value as string;
    seen.delete(oldest);
  }
}

async function start(): Promise<void> {
  await connectRabbit();

  // ONE durable queue for this consumer group, bound to the customer-relevant
  // patterns. The exchange copies each matching event here AND to the saga
  // services' queues — the fan-out. Scale this service to N replicas and the
  // replicas become competing consumers of THIS queue (each event still
  // notified exactly once per consumer group).
  await subscribe(
    'notification.events',
    ['order.created', 'payment.succeeded', 'payment.failed', 'inventory.rejected'],
    onEvent,
  );

  await app.listen({ host: config.host, port: config.port });
  logger.info({ port: config.port, instance: INSTANCE_ID }, 'notification-service listening');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  await app.close();
  await closeRabbit();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err) => { logger.error({ err }, 'failed to start'); process.exit(1); });
