// ────────────────────────────────────────────────────────────────────────────
// config.ts — Inventory service config. Secrets via files, config via env.
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
  serviceName: 'inventory-service',
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '3000')),
  logLevel: readEnv('LOG_LEVEL', 'info'),
  db: {
    host: readEnv('DB_HOST', 'inventory-db'),
    port: Number(readEnv('DB_PORT', '5432')),
    database: readEnv('DB_NAME', 'inventorydb'),
    user: readEnv('DB_USER', 'inventoryuser'),
    password: readSecret('DB_PASSWORD'),
  },
  rabbit: {
    url: readEnv('RABBITMQ_URL', 'amqp://guest:guest@rabbitmq:5672'),
  },
} as const;
