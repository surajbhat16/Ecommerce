// ────────────────────────────────────────────────────────────────────────────
// db.ts — PostgreSQL connection pool. Each service connects to its OWN database
// (database-per-service). ping() backs the readiness probe.
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
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, 'PostgreSQL pool error'));

export async function ping(): Promise<boolean> {
  try { await pool.query('SELECT 1'); return true; }
  catch (err) { logger.warn({ err }, 'db ping failed'); return false; }
}

export async function closePool(): Promise<void> { await pool.end(); }
