// ────────────────────────────────────────────────────────────────────────────
// index.ts — HTTP server entrypoint for the Auth service.
//
// This file demonstrates several DevOps-critical patterns:
//   1. LIVENESS vs READINESS health endpoints (the distinction interviewers probe).
//   2. A /metrics endpoint stub (real Prometheus metrics arrive in Phase 5).
//   3. GRACEFUL SHUTDOWN on SIGTERM (the "PID 1" problem — see Dockerfile notes).
//   4. An instance id echoed in responses so you can SEE load balancing work.
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { registry, httpRequestDuration } from './metrics.js';
import { ping, closePool } from './db.js';
import { registerUser, loginUser } from './auth.js';

// A unique id per running process. When you scale this service and Traefik
// round-robins requests, you'll see this value change between responses — that
// is your visual proof that load balancing is happening.
const INSTANCE_ID = randomUUID().slice(0, 8);

const app = Fastify({
  logger: false, // We use our own pino logger for full control over the shape.
  // Trust the X-Forwarded-* headers set by Traefik (the reverse proxy) so the
  // service sees the real client protocol/IP rather than the proxy's.
  trustProxy: true,
});

// ── Health: LIVENESS ────────────────────────────────────────────────────────
// "Is the process alive?" Must be CHEAP and must NOT touch dependencies.
// If this fails, the orchestrator RESTARTS the container.
// It deliberately does NOT check the database — a DB outage should not cause
// every app container to be killed and restarted in a storm.
app.get('/health/live', async () => {
  return { status: 'alive', service: config.serviceName, instance: INSTANCE_ID };
});

// ── Health: READINESS ─────────────────────────────────────────────────────────
// "Can I serve traffic right now?" This DOES check dependencies (the DB).
// If this fails, the orchestrator STOPS SENDING TRAFFIC (but does not restart).
app.get('/health/ready', async (_req, reply) => {
  const dbOk = await ping();
  if (!dbOk) {
    // 503 = Service Unavailable. Traefik/k8s interpret this as "not ready".
    return reply.code(503).send({ status: 'not-ready', db: 'down', instance: INSTANCE_ID });
  }
  return { status: 'ready', db: 'up', instance: INSTANCE_ID };
});

// ── Metrics stub ──────────────────────────────────────────────────────────────
// Real Prometheus metrics land in Phase 5. Exposing the endpoint now keeps the
// contract stable so nothing has to be re-plumbed later.
// ── Prometheus metrics (Phase 5) ─────────────────────────────────────────────
// R.E.D. histogram on every response. /metrics and health probes are excluded:
// scraping the scraper and liveness noise would pollute rate() queries.
app.addHook('onResponse', async (req, reply) => {
  const route = req.routeOptions?.url ?? req.url;
  if (route === '/metrics' || route.startsWith('/health')) return;
  httpRequestDuration
    .labels(req.method, route, String(reply.statusCode))
    .observe(reply.elapsedTime / 1000);
});
app.get('/metrics', async (_req, reply) => {
  reply.header('content-type', registry.contentType);
  return registry.metrics();
});

// ── Business endpoints ────────────────────────────────────────────────────────
app.post<{ Body: { email?: string; password?: string } }>('/register', async (req, reply) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return reply.code(400).send({ error: 'email and password are required' });
  }
  try {
    const user = await registerUser(email, password);
    logger.info({ userId: user.id }, 'user registered');
    return reply.code(201).send({ user, servedBy: INSTANCE_ID });
  } catch (err: any) {
    // 23505 = unique_violation in Postgres → email already taken.
    if (err?.code === '23505') {
      return reply.code(409).send({ error: 'email already registered' });
    }
    logger.error({ err }, 'registration failed');
    return reply.code(500).send({ error: 'internal error' });
  }
});

app.post<{ Body: { email?: string; password?: string } }>('/login', async (req, reply) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return reply.code(400).send({ error: 'email and password are required' });
  }
  const tokens = await loginUser(email, password);
  if (!tokens) {
    return reply.code(401).send({ error: 'invalid credentials' });
  }
  return reply.send({ ...tokens, servedBy: INSTANCE_ID });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info({ port: config.port, instance: INSTANCE_ID }, 'auth-service listening');
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
// DEVOPS CONCEPT: when Docker stops a container it sends SIGTERM, waits a grace
// period, then SIGKILLs. We must catch SIGTERM, stop accepting new connections,
// finish in-flight requests, drain the DB pool, and exit cleanly. Without this,
// requests get cut mid-flight and connections leak.
//
// NOTE: this only works if our process actually RECEIVES SIGTERM as PID 1. In a
// shell-form Docker CMD, the shell is PID 1 and signals don't reach Node. We use
// an init (tini, via `--init` / exec-form CMD) in the Dockerfile to fix that.
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down gracefully');
  try {
    await app.close();   // stop accepting new requests, finish in-flight ones
    await closePool();   // drain DB connections
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
