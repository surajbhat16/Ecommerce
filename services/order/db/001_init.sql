-- ─────────────────────────────────────────────────────────────────────────────
-- 001_init.sql — Order schema, including the SAGA state machine and the OUTBOX.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Orders. `status` is the saga state machine:
--   PENDING → (inventory reserved) → AWAITING_PAYMENT → (paid) → CONFIRMED
--   PENDING → (out of stock) → REJECTED
--   AWAITING_PAYMENT → (payment failed) → FAILED (after inventory released)
CREATE TABLE IF NOT EXISTS orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    total_cents INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    sku        TEXT NOT NULL,
    quantity   INTEGER NOT NULL CHECK (quantity > 0)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- THE TRANSACTIONAL OUTBOX.
--
-- Problem it solves (the "dual write"): when we create an order we must BOTH
-- write the order row AND publish an "order.created" event. If we write to the DB
-- and then publish separately, a crash between the two loses the event (order
-- exists, saga never starts) or double-publishes. You cannot do a DB transaction
-- and a broker publish atomically.
--
-- Solution: within the SAME DB transaction that writes the order, also INSERT a
-- row into this outbox table. Both commit together atomically. A separate relay
-- process then reads unpublished outbox rows and publishes them to RabbitMQ,
-- marking them published. The event is guaranteed to be sent at-least-once.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    routing_key  TEXT NOT NULL,
    payload      JSONB NOT NULL,
    published    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox (published) WHERE published = FALSE;
