import pino from 'pino';
import { config } from './config.js';

// Structured JSON logs to stdout — identical pattern to every other service so
// the aggregated log stream (Loki, Phase 5) has a consistent shape.
export const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
});
