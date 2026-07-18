// ────────────────────────────────────────────────────────────────────────────
// config.ts — Notification service config.
//
// Note what is ABSENT: no DB_*, no secrets. This service is a pure event
// consumer — it owns no persistent state. That absence is the point of the
// phase: consumers can be added to the system without new datastores, new
// secrets, or any change to the producers.
// ────────────────────────────────────────────────────────────────────────────
function readEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  serviceName: 'notification-service',
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '3000')),
  logLevel: readEnv('LOG_LEVEL', 'info'),
  rabbit: {
    url: readEnv('RABBITMQ_URL', 'amqp://guest:guest@rabbitmq:5672'),
  },
  // How many recently "sent" notifications to keep in memory for the demo
  // endpoint GET /notifications. A bounded buffer — this is observability
  // sugar, not a datastore.
  historySize: Number(readEnv('NOTIFICATION_HISTORY_SIZE', '100')),
} as const;
