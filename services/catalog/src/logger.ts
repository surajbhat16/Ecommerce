import pino from 'pino';
import { config } from './config.js';

// Structured JSON logs to stdout — same pattern as every service, so the
// aggregated stream (Loki, Phase 5) stays uniform and filterable by service.
export const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
});
