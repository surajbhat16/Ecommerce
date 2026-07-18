// ────────────────────────────────────────────────────────────────────────────
// mongo.ts — MongoDB connection + collection access.
//
// WHY MONGODB FOR THE CATALOG (the polyglot-persistence talking point):
// products have wildly varying attributes per category — a book has an ISBN and
// page count; a t-shirt has sizes and colours; a laptop has RAM and CPU. In a
// relational model you'd fight this with sparse columns, EAV tables, or JSON
// columns. A document store lets each product carry exactly the fields it needs.
//
// The MongoDB driver maintains an internal connection POOL automatically, so we
// connect once at startup and reuse the client for the process lifetime.
// ────────────────────────────────────────────────────────────────────────────

import { MongoClient, type Collection, type Db } from 'mongodb';
import { config } from './config.js';
import { logger } from './logger.js';

// A product document. `attributes` is an open-ended bag of category-specific
// fields — the whole reason we chose a document store.
export interface Product {
  _id?: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  priceCents: number;          // store money as integer cents, never floats
  currency: string;
  attributes: Record<string, unknown>;
  createdAt: Date;
}

let client: MongoClient;
let db: Db;

/** Build the connection URI. Credentials come from config (password is a secret). */
function buildUri(): string {
  const { user, password, host, port, database } = config.mongo;
  // authSource=admin because the root user is created in the admin database by
  // the official mongo image's MONGO_INITDB_ROOT_* variables.
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?authSource=admin`;
}

/** Connect once at startup and ensure indexes exist. */
export async function connectMongo(): Promise<void> {
  client = new MongoClient(buildUri(), {
    // Pool sizing — same discipline as the Postgres pool: modest per-instance.
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5_000,
  });
  await client.connect();
  db = client.db(config.mongo.database);

  // Indexes are as important in Mongo as in SQL. Without them, queries do a full
  // collection scan (COLLSCAN) — fine for 10 docs, catastrophic for 10 million.
  const col = products();
  await col.createIndex({ sku: 1 }, { unique: true });   // fast lookup + uniqueness
  await col.createIndex({ category: 1 });                 // browse-by-category path
  await col.createIndex({ name: 'text', description: 'text' }); // text search

  logger.info('connected to MongoDB and ensured indexes');
}

export function products(): Collection<Product> {
  return db.collection<Product>('products');
}

/** Readiness ping — `ping` admin command confirms the server is reachable. */
export async function pingMongo(): Promise<boolean> {
  try {
    await db.command({ ping: 1 });
    return true;
  } catch (err) {
    logger.warn({ err }, 'mongo ping failed');
    return false;
  }
}

export async function closeMongo(): Promise<void> {
  await client?.close();
}
