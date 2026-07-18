-- ─────────────────────────────────────────────────────────────────────────────
-- 001_init.sql — Payment schema.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Payment records. `idempotency_key` (the order id) is UNIQUE, so a redelivered
-- charge request for the same order can't create a second charge — the insert
-- conflicts and we return the existing result. This is the IDEMPOTENCY KEY pattern.
CREATE TABLE IF NOT EXISTS payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  UUID NOT NULL UNIQUE,       -- = orderId
    amount_cents     INTEGER NOT NULL,
    status           TEXT NOT NULL,              -- 'succeeded' | 'failed'
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
