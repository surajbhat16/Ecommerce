// ────────────────────────────────────────────────────────────────────────────
// rabbit.ts — RabbitMQ connection + publish/consume helpers.
//
// KEY MESSAGING CONCEPTS wired in here:
//   - TOPIC EXCHANGE: publishers send to an exchange with a routing key; the
//     exchange routes to queues by pattern. Decouples producers from consumers.
//   - DURABLE queues + PERSISTENT messages: survive a broker restart (so we
//     don't lose in-flight saga events).
//   - MANUAL ACK: a consumer acks a message only AFTER successfully processing
//     it. If it crashes mid-processing, the unacked message is redelivered
//     (this is AT-LEAST-ONCE delivery — hence idempotency matters downstream).
//   - DEAD-LETTER EXCHANGE (DLX): messages that are rejected (nacked without
//     requeue) or exceed retry are routed to a dead-letter queue for inspection,
//     instead of being silently dropped or looping forever.
// ────────────────────────────────────────────────────────────────────────────
import amqp from 'amqplib';
import { config } from './config.js';
import { logger } from './logger.js';

export const EXCHANGE = 'ecommerce.events';        // topic exchange for all events
export const DLX = 'ecommerce.events.dlx';         // dead-letter exchange
export const DLQ = 'ecommerce.events.dead';        // dead-letter queue

let connection: amqp.ChannelModel;
let channel: amqp.Channel;

/** Connect, assert the exchange/DLX/DLQ topology. Idempotent asserts. */
export async function connectRabbit(): Promise<void> {
  connection = await amqp.connect(config.rabbit.url);
  channel = await connection.createChannel();

  // Topic exchange — durable so it survives broker restart.
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

  // Dead-letter topology: a fanout DLX feeding a single dead-letter queue.
  await channel.assertExchange(DLX, 'fanout', { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, '');

  // prefetch(1): don't hand a consumer a new message until it acks the current
  // one. Prevents one slow consumer from hoarding the queue; enables fair
  // dispatch across replicas.
  await channel.prefetch(1);

  logger.info('connected to RabbitMQ and asserted topology');
}

/** Publish a persistent event with a routing key (e.g. "order.created"). */
export function publish(routingKey: string, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  // persistent: true → the message is written to disk, surviving broker restart.
  channel.publish(EXCHANGE, routingKey, body, {
    persistent: true,
    contentType: 'application/json',
  });
  logger.info({ routingKey }, 'event published');
}

/**
 * Subscribe a durable queue to one or more routing-key patterns, with a handler.
 * The queue is bound to the DLX so poisoned messages are dead-lettered.
 *
 * The handler returns void on success (→ ack) or throws on failure. On throw we
 * nack WITHOUT requeue → the message is dead-lettered (not looped forever).
 */
export async function subscribe(
  queue: string,
  patterns: string[],
  handler: (routingKey: string, payload: any) => Promise<void>,
): Promise<void> {
  await channel.assertQueue(queue, {
    durable: true,
    deadLetterExchange: DLX,   // rejected messages go here
  });
  for (const p of patterns) await channel.bindQueue(queue, EXCHANGE, p);

  await channel.consume(queue, async (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(routingKey, payload);
      channel.ack(msg);                       // success → remove from queue
    } catch (err) {
      logger.error({ err, routingKey }, 'handler failed; dead-lettering message');
      // requeue:false → don't loop; send to the dead-letter queue for inspection.
      channel.nack(msg, false, false);
    }
  });

  logger.info({ queue, patterns }, 'subscribed');
}

export async function closeRabbit(): Promise<void> {
  try { await channel?.close(); await connection?.close(); } catch { /* ignore */ }
}

export function getChannel(): amqp.Channel { return channel; }
