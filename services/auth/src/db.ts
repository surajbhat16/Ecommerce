// ────────────────────────────────────────────────────────────────────────────
// db.ts — PostgreSQL connection pool + helpers.
//
// We use a connection POOL, not a single connection. Each HTTP request borrows a
// connection from the pool and returns it. This is essential under load: opening
// a fresh TCP+TLS+auth connection per request would crush both app and database.
//
// DEVOPS CONCEPT (readiness): `ping()` below is what the /health/ready probe
// calls. Readiness = "can I actually serve traffic right now", which for this
// service means "is my database reachable". If the DB is down, we report NOT
// ready, the orchestrator stops routing traffic to us, and we don't return 500s.
// ────────────────────────────────────────────────────────────────────────────

import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  // Pool sizing: keep it modest. With many replicas each holding a pool, total
  // connections = replicas × max. Postgres has a hard connection ceiling, so
  // small per-instance pools are the disciplined choice.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // A pool-level error (e.g. backend terminated) must be logged, not swallowed.
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

/** Lightweight liveness/readiness check for the DB. Returns true if reachable. */
export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Database ping failed');
    return false;
  }
}

/** Graceful shutdown: drain the pool so in-flight queries finish cleanly. */
export async function closePool(): Promise<void> {
  await pool.end();
}
