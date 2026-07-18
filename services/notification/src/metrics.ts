// ────────────────────────────────────────────────────────────────────────────
// metrics.ts — Prometheus instrumentation (Phase 5).
//
// prom-client keeps metrics in-process; Prometheus PULLS them from /metrics on
// its own schedule. Default metrics cover the Node runtime (heap, GC, event
// loop lag); the histogram below gives the R.E.D. view (Rate, Errors,
// Duration) of every HTTP route. Buckets are chosen for a local sub-second
// system: 5ms → 5s. `service` is set as a default label so every series from
// this process is attributable without relying on scrape-config labels.
// ────────────────────────────────────────────────────────────────────────────
import client from 'prom-client';
import { config } from './config.js';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: config.serviceName });
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// Domain metric: notifications "sent", by triggering event.
export const notificationsSentTotal = new client.Counter({
  name: 'notifications_sent_total',
  help: 'Notifications sent, by triggering event',
  labelNames: ['event'] as const,
  registers: [registry],
});
