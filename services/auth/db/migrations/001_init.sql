-- ─────────────────────────────────────────────────────────────────────────────
-- 001_init.sql — Auth service schema.
--
-- This runs automatically on first DB startup: the official Postgres image
-- executes any *.sql / *.sh files mounted into /docker-entrypoint-initdb.d/
-- (we wire that mount in the compose data file).
--
-- DATABASE-PER-SERVICE: this schema lives in the auth service's OWN database.
-- No other service may read or write these tables. That isolation is enforced
-- both here (separate DB) and at the NETWORK layer (the `auth-data` network is
-- internal: true and only auth-service + auth-db are attached to it).
-- ─────────────────────────────────────────────────────────────────────────────

-- pgcrypto gives us gen_random_uuid() for UUID primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,            -- argon2id hash (salt embedded)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the login lookup path (email is already UNIQUE, which creates an
-- index, but we keep this explicit for clarity in interviews).
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
