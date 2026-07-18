// ────────────────────────────────────────────────────────────────────────────
// config.ts — Payment service config.
// ────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';

function readSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) return readFileSync(filePath, 'utf8').trim();
  const inline = process.env[name];
  if (inline) return inline;
  throw new Error(`Missing required secret: ${name}_FILE or ${name}`);
}
function readEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  serviceName: 'payment-service',
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '3000')),
  logLevel: readEnv('LOG_LEVEL', 'info'),
  db: {
    host: readEnv('DB_HOST', 'payment-db'),
    port: Number(readEnv('DB_PORT', '5432')),
    database: readEnv('DB_NAME', 'paymentdb'),
    user: readEnv('DB_USER', 'paymentuser'),
    password: readSecret('DB_PASSWORD'),
  },
  rabbit: {
    url: readEnv('RABBITMQ_URL', 'amqp://guest:guest@rabbitmq:5672'),
  },
  // DETERMINISTIC FAILURE: any order containing this SKU always fails payment.
  // This lets you demo the compensation path on demand (repeatable), instead of
  // relying on random failure. Change via env without rebuilding.
  failOnSku: readEnv('PAYMENT_FAIL_SKU', 'LAPTOP-001'),
} as const;
