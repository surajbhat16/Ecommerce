-- ─────────────────────────────────────────────────────────────────────────────
-- 001_init.sql — Inventory schema.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Stock levels per SKU. `reserved` tracks units held for in-flight orders.
CREATE TABLE IF NOT EXISTS stock (
    sku        TEXT PRIMARY KEY,
    available  INTEGER NOT NULL CHECK (available >= 0),
    reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);

-- IDEMPOTENCY / PROCESSED-EVENTS table. Because message delivery is at-least-once,
-- the same event may arrive more than once. We record every processed order id so
-- a duplicate "reserve inventory for order X" is a no-op instead of double-reserving.
CREATE TABLE IF NOT EXISTS processed_reservations (
    order_id   UUID PRIMARY KEY,
    outcome    TEXT NOT NULL,               -- 'reserved' | 'rejected'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed some stock. LAPTOP-001 is deliberately scarce so you can trigger the
-- out-of-stock rejection path on demand.
INSERT INTO stock (sku, available) VALUES
    ('BOOK-001', 100),
    ('SHIRT-001', 50),
    ('LAPTOP-001', 2)
ON CONFLICT (sku) DO NOTHING;
