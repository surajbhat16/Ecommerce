// ────────────────────────────────────────────────────────────────────────────
// logger.ts — Structured JSON logging.
//
// DEVOPS CONCEPT: in a containerised system you NEVER write logs to files inside
// the container. You write structured JSON to stdout/stderr, and the container
// runtime + a log shipper (Promtail → Loki, added in Phase 5) collect them.
//
// Why JSON and not pretty text? Because machines parse logs in production. JSON
// lines are queryable ("show me all logs where level=error and userId=42").
// Pino emits newline-delimited JSON to stdout by default — exactly what we want.
// ────────────────────────────────────────────────────────────────────────────

import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  // Attach service name to every line so that when logs from all services are
  // aggregated in Loki, you can filter by service.
  base: { service: config.serviceName },
  // ISO timestamps are unambiguous across timezones.
  timestamp: pino.stdTimeFunctions.isoTime,
});
