// ────────────────────────────────────────────────────────────────────────────
// config.ts — Centralised, validated configuration (12-factor app, factor III).
//
// KEY DEVOPS CONCEPT: "secrets via files, config via env".
//
//   * Non-sensitive config (ports, hostnames, log level) → environment variables.
//   * Sensitive config (DB password, JWT signing key) → Docker SECRETS, which are
//     mounted as files at /run/secrets/<name>. We read the FILE, never an env var.
//
// Why not just use env vars for secrets too? Because env vars leak:
//   - `docker inspect <container>` prints the full env.
//   - Child processes inherit them.
//   - They often end up in logs / crash dumps.
// A file mounted into a tmpfs (which is how Docker secrets work) is far safer.
//
// PATTERN: every secret supports a `<NAME>_FILE` env var pointing at the secret
// file. This is the de-facto standard (Postgres, MySQL, etc. all use *_FILE).
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

/**
 * Read a secret's value. Preference order:
 *   1. <NAME>_FILE  → read the file at that path (this is the Docker-secret path).
 *   2. <NAME>       → fall back to a raw env var (handy for local `npm run dev`).
 * Throws if neither is present, because a missing secret must fail loudly at boot,
 * never silently at request time.
 */
function readSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, 'utf8').trim();
  }
  const inline = process.env[name];
  if (inline) {
    return inline;
  }
  throw new Error(
    `Missing required secret: set either ${name}_FILE (preferred, Docker secret) or ${name}`,
  );
}

/** Read a plain env var with an optional default. Throws if required and absent. */
function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  // ── Service identity & networking ────────────────────────────────────────
  serviceName: 'auth-service',
  // Bind to 0.0.0.0 so the process is reachable from other containers on the
  // Docker network (binding to 127.0.0.1 would make it container-internal only).
  host: '0.0.0.0',
  port: Number(readEnv('PORT', '3000')),
  logLevel: readEnv('LOG_LEVEL', 'info'),

  // ── PostgreSQL connection ────────────────────────────────────────────────
  // Host/port/db/user are NON-sensitive → env vars.
  // Password is sensitive → Docker secret (read from a file).
  db: {
    host: readEnv('DB_HOST', 'auth-db'),
    port: Number(readEnv('DB_PORT', '5432')),
    database: readEnv('DB_NAME', 'authdb'),
    user: readEnv('DB_USER', 'authuser'),
    password: readSecret('DB_PASSWORD'),
  },

  // ── JWT signing ──────────────────────────────────────────────────────────
  // The signing key is the crown jewel — always a secret, never an env var.
  jwt: {
    signingKey: readSecret('JWT_SIGNING_KEY'),
    accessTtlSeconds: Number(readEnv('JWT_ACCESS_TTL', '900')),       // 15 min
    refreshTtlSeconds: Number(readEnv('JWT_REFRESH_TTL', '604800')),  // 7 days
    issuer: readEnv('JWT_ISSUER', 'ecommerce-auth'),
  },
} as const;

export type AppConfig = typeof config;
