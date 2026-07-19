# Phase 2 — Concept Deep-Dives

Four concepts underpin Phase 2, each covered here in depth with mechanics, worked
examples, and senior-level interview Q&A:

1. Polyglot persistence
2. MongoDB document modeling
3. The cache-aside pattern
4. Redis as a primary datastore

---

## 1. Polyglot Persistence

### The principle

Polyglot persistence means using *different* database technologies within one
system, each chosen because it fits a particular service's data and access
pattern — instead of forcing every service onto one database because it's
familiar. In this platform: PostgreSQL for Auth/Order/Payment (ACID, relational
integrity, transactions), MongoDB for the Catalog (flexible per-category product
schemas), and Redis for Cart (ephemeral session state) and as the Catalog cache.

The idea rests on a simple observation: databases make trade-offs, and no single
database is optimal for every workload. A relational database gives you strong
consistency, joins, and transactions but rigid schemas. A document store gives
you schema flexibility and fast single-document reads but weaker multi-document
transactional guarantees. An in-memory key-value store gives you microsecond
latency and native TTL but limited query capability and weaker durability. When
your system has services with genuinely different needs, matching each to the
right store beats compromising on one.

### The minute sub-concepts

**Database-per-service is the precondition.** Polyglot persistence only works
cleanly if each service owns its own datastore. If services shared one database,
you couldn't give each a different technology, and you'd reintroduce the coupling
microservices exist to avoid. In this project the ownership is enforced at the
network layer: each datastore sits on an `internal: true` network that only its
owning service joins. The Catalog service physically cannot reach the Cart Redis.

**Access pattern is the deciding axis, not data type.** The senior instinct is to
choose by *how the data is read and written*, not by what it "is." Carts and
orders are both "e-commerce data," but carts are high-churn, ephemeral, key-scoped
(Redis), while orders are durable, relational, transactional (Postgres). Same
domain, opposite stores, because the access patterns differ.

**Consistency models differ per store, and that leaks into your architecture.**
Postgres is strongly consistent. Redis is effectively strongly consistent for a
single node but its replication is asynchronous. MongoDB's consistency depends on
read/write concern settings. When you go polyglot, you accept that different parts
of your system have different consistency guarantees — and your cross-service
flows (the Phase 3 saga) must be designed around eventual consistency because you
can't run one ACID transaction across Postgres, Mongo, and Redis.

**No distributed transactions across stores.** You cannot `BEGIN...COMMIT` across
a Postgres order and a Redis cart and a Mongo catalog. This is why the checkout
flow uses a Saga with compensating actions (Phase 3) instead of a single
transaction. Polyglot persistence forces you to solve consistency at the
application/orchestration layer.

**Operational cost is the real tax.** Every additional database technology is
another thing to deploy, monitor, back up, patch, tune, and hire expertise for.
Three databases mean three backup strategies, three failure modes, three sets of
metrics. This is the single biggest argument *against* polyglot persistence, and
the mature answer to "should we?" is "only when the workload difference justifies
the operational overhead."

**Data duplication and synchronization.** When the same logical entity appears in
multiple stores (a product in Mongo, cached in Redis, referenced by SKU in an
order in Postgres), you must decide how they stay consistent. Usually via events:
one store is the source of truth and others are updated/invalidated via published
events. This project invalidates the Redis cache on catalog writes; Phase 3 will
propagate state via RabbitMQ events.

### Practical worked example

Consider three services and why each store is correct:

**Auth on PostgreSQL.** A user has a fixed schema (email, password hash, created
timestamp), needs a unique constraint on email, and login is a single indexed
lookup. You want ACID: when you create a user you must not end up with a
half-written row. Relational integrity and transactions make Postgres the fit.

```sql
-- Strong schema + uniqueness + transactional guarantees.
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
```

**Catalog on MongoDB.** A product's fields vary by category — a book has ISBN and
page count, a laptop has RAM and CPU. Forcing this into relational columns means
either dozens of mostly-null columns or an awkward EAV table. A document naturally
holds a per-product `attributes` object:

```javascript
// Two products, totally different attribute shapes, same collection:
{ sku: "BOOK-001",   attributes: { isbn: "978-...", pages: 352 } }
{ sku: "LAPTOP-001", attributes: { ramGb: 16, cpu: "M-series", ports: ["USB-C"] } }
```

**Cart on Redis.** A cart is a short-lived map of SKU → quantity, written on every
"add to cart" click, read on every cart view, and abandoned carts should expire.
Redis hashes model this exactly, `HINCRBY` makes increments atomic, and native TTL
handles expiry — no cron job needed:

```
HINCRBY cart:user-42 SHIRT-001 1     # add one, atomically
EXPIRE  cart:user-42 86400           # expire 24h after last activity
```

Trying to do any one of these in the "wrong" store works but is worse: carts in
Postgres need a cleanup job for expiry and a write amplification you don't want;
products in Postgres fight the schema; users in Redis lose durability and
relational integrity.

### 10 senior interview questions

1. **Define polyglot persistence and give the decision framework you'd use to
   decide whether a new service should get its own database technology or reuse an
   existing one.** (Access pattern, consistency needs, query complexity, durability
   requirements, weighed against operational cost and team expertise.)

2. **Your team proposes adding a fourth database technology for one service. Argue
   both for and against, and state what evidence would make you approve it.**
   (Fit vs. operational tax; approve only if the workload is materially mismatched
   to existing stores and the cost of misfit exceeds the cost of a new store.)

3. **Explain why database-per-service is a prerequisite for polyglot persistence,
   and how you'd enforce it technically rather than by convention.** (Shared DBs
   prevent per-service tech choice and recouple services; enforce via network
   isolation, separate credentials, no cross-service schema access.)

4. **You have a product entity in MongoDB, cached in Redis, and referenced by SKU
   in Postgres orders. Walk through how you keep these consistent when a product's
   price changes.** (Mongo is source of truth; invalidate/refresh Redis; orders
   snapshot the price at purchase time rather than referencing live price.)

5. **Why can't you use a single ACID transaction across a polyglot system, and
   what patterns replace it?** (No distributed transaction across heterogeneous
   stores; Saga with compensation, outbox pattern, eventual consistency.)

6. **Compare the consistency guarantees of Postgres, MongoDB, and Redis, and
   explain how those differences constrain a cross-service workflow.** (Strong vs.
   tunable vs. single-node-strong/async-replicated; workflow must tolerate the
   weakest guarantee involved.)

7. **A stakeholder says "let's just put everything in Postgres with JSONB columns
   to avoid MongoDB." Evaluate that position.** (Valid and often correct — JSONB
   gives document flexibility with relational strengths; MongoDB wins on horizontal
   scaling, certain query ergonomics, and operational model; decide by scale and
   query needs, not dogma.)

8. **How does polyglot persistence complicate observability and on-call, and how
   do you mitigate it?** (N sets of metrics/alerts/runbooks; mitigate with unified
   dashboards, per-store SLOs, standardized health checks, shared tracing.)

9. **Describe how you'd back up and restore a polyglot system consistently when
   the stores have no shared transaction boundary.** (Per-store backups can't be
   globally point-in-time; rely on event replay/outbox, idempotent recovery,
   accept eventual re-convergence rather than a single consistent snapshot.)

10. **When would you *reverse* a polyglot decision and consolidate onto fewer
    databases?** (When operational cost outweighs fit benefit, team can't support
    the sprawl, or workloads converged; consolidation reduces failure modes.)

11. **Explain "the right tool for the job" as both a genuine principle and a
    potential anti-pattern (resume-driven development). How do you tell them
    apart?** (Genuine when workload demands it and cost is justified; anti-pattern
    when driven by novelty; the test is whether you can articulate the specific
    access-pattern mismatch that the new store resolves.)

---

## 2. MongoDB Document Modeling

### The principle

MongoDB stores data as BSON documents (binary JSON) grouped into collections.
Document modeling is the discipline of deciding how to structure those documents —
what to embed, what to reference, how to index — so reads and writes are efficient
for your actual access patterns. The golden rule that separates it from relational
modeling: **you model around how the data is accessed, not around normalizing to
eliminate duplication.**

### The minute sub-concepts

**Documents, collections, BSON.** A document is a JSON-like object with a unique
`_id`. A collection is a group of documents (loosely analogous to a table, but
without an enforced schema). BSON extends JSON with types JSON lacks — `Date`,
`ObjectId`, binary, decimal128 — and is what MongoDB stores and transmits.

**`_id` and `ObjectId`.** Every document has a unique `_id`. If you don't supply
one, MongoDB generates an `ObjectId`: a 12-byte value encoding a timestamp, a
machine/process identifier, and a counter. ObjectIds are roughly monotonic (sortable
by creation time) and generated client-side, which matters for insert performance
and for sharding.

**Embedding vs. referencing — the central decision.** *Embedding* nests related
data inside one document (order with its line items inside it). *Referencing*
stores an id pointing to another document (order storing `userId`, user lives
elsewhere). Embed when data is accessed together, has a bounded size, and is owned
by the parent (the "contains" relationship). Reference when data is large, shared
across many parents, unbounded in growth, or independently queried.

**The 16MB document limit.** A single BSON document cannot exceed 16MB. This is a
hard design constraint: you cannot embed an unbounded, ever-growing array (e.g.
every event for a user for all time) in one document — it will eventually blow the
limit. Unbounded one-to-many relationships must be referenced or bucketed, not
embedded. This is the classic "massive arrays" anti-pattern.

**Indexes.** Without an index, a query scans every document in the collection
(COLLSCAN) — O(n). An index (a B-tree) makes lookups O(log n). Types you must know:
single-field, compound (multiple fields, order matters — the "ESR" rule: Equality,
Sort, Range), multikey (over array fields), text (for search), TTL (auto-expiring
documents), and unique. In this project the catalog indexes `sku` (unique),
`category`, and a text index on name/description.

**The ESR rule for compound indexes.** When building a compound index for a query
that filters, sorts, and range-scans, order the fields Equality first, then Sort,
then Range. Getting this order wrong means the index can't be fully used and Mongo
falls back to in-memory sorts or partial scans.

**Read/write concern.** *Write concern* controls how many nodes must acknowledge a
write before it's considered done (`w:1` = primary only; `w:majority` = a majority
of the replica set — durable against primary failure). *Read concern* controls the
consistency of reads (`local`, `majority`, `linearizable`). These are your knobs on
the consistency/latency trade-off.

**The aggregation pipeline.** Beyond simple finds, MongoDB has a pipeline of stages
(`$match`, `$group`, `$sort`, `$lookup`, `$project`, `$unwind`) that transform
documents in sequence — analogous to SQL's GROUP BY/JOIN but composed as an array
of stages. `$lookup` performs a left-outer join to another collection (used
sparingly; heavy joins are a signal you might be fighting the document model).

**Schema flexibility is not schema-lessness.** MongoDB doesn't enforce a schema by
default, but production systems use schema validation (JSON Schema rules on the
collection) to prevent malformed documents. "Flexible" means fields can vary where
they should (per-category attributes), not that anything goes everywhere.

### Practical worked example

The catalog's `attributes` field is the embedding decision in action — category-
specific attributes are *owned by* the product, *accessed with* the product, and
*bounded* in size, so they're embedded rather than referenced to an attributes
table:

```javascript
{
  _id: ObjectId("..."),
  sku: "LAPTOP-001",
  name: "UltraBook 14",
  category: "electronics",
  priceCents: 129999,
  attributes: { ramGb: 16, cpu: "M-series", ports: ["USB-C", "HDMI"] },
  createdAt: ISODate("...")
}
```

Indexing for the two read paths (get-by-sku and browse-by-category):

```javascript
db.products.createIndex({ sku: 1 }, { unique: true }); // point lookup + uniqueness
db.products.createIndex({ category: 1 });               // browse path
db.products.createIndex({ name: "text", description: "text" }); // search
```

A referencing example — orders should NOT embed the full user document (a user is
shared across many orders, changes independently, and embedding would duplicate and
de-sync it). Reference by id instead:

```javascript
// GOOD: reference the user; snapshot only immutable facts you need at order time.
{ _id: ObjectId("..."), userId: "user-42", items: [{ sku: "BOOK-001", qty: 1, priceCentsAtPurchase: 3999 }] }
```

Note `priceCentsAtPurchase`: the order embeds the price *as it was* at purchase
(an immutable snapshot), rather than referencing the live catalog price — because
an order's total must not change when the catalog price later changes. That's a
modeling decision driven by business meaning, not normalization.

An aggregation pipeline computing revenue per category:

```javascript
db.orders.aggregate([
  { $unwind: "$items" },
  { $group: { _id: "$items.category", revenue: { $sum: "$items.priceCentsAtPurchase" } } },
  { $sort: { revenue: -1 } }
]);
```

### 10 senior interview questions

1. **Walk through your decision process for embedding vs. referencing. Give a
   concrete case for each and the signals that tip you.** (Contains/bounded/
   accessed-together → embed; shared/unbounded/independently-queried → reference.)

2. **Explain the 16MB document limit and how it shapes modeling of one-to-many
   relationships. What's the "massive arrays" anti-pattern and its fix?**
   (Unbounded embedded arrays eventually exceed 16MB; fix via referencing or the
   bucket pattern.)

3. **Describe the ESR rule for compound indexes and show a query where getting the
   field order wrong degrades performance.** (Equality, Sort, Range; wrong order
   forces in-memory sort or scan.)

4. **What is an `ObjectId` composed of, why is it generated client-side, and what
   are the implications for insert performance and sharding?** (Timestamp+machine+
   counter; client generation avoids a round-trip; near-monotonic affects index
   locality and shard key choice.)

5. **Contrast write concern `w:1` and `w:majority`, and read concern `local` vs.
   `majority`. When does each matter?** (Durability vs. latency; majority survives
   primary failover; read majority avoids reading rolled-back writes.)

6. **When is `$lookup` appropriate, and when does needing it signal a modeling
   problem?** (Occasional joins fine; frequent heavy joins suggest you should have
   embedded or denormalized, or that a relational store fits better.)

7. **You must store a product price and later report on what a customer actually
   paid. How do you model this so historical orders are correct after price
   changes?** (Snapshot price into the order; never reference live catalog price
   for historical totals.)

8. **How do you enforce data quality in a "schema-less" database?** (JSON Schema
   validation on the collection, application-layer validation, required fields,
   type constraints.)

9. **Explain multikey indexes and their gotchas when indexing array fields.**
   (Index entry per array element; can't create a compound index across two array
   fields; cardinality/size implications.)

10. **Design the indexes for a catalog supporting get-by-sku, browse-by-category
    sorted by price, and full-text search. Justify each and note write-cost.**
    (Unique sku; compound {category:1, priceCents:1} by ESR; text index; each index
    adds write amplification and storage — index only real query paths.)

11. **Explain the TTL index and how it enables auto-expiring documents. How is it
    different from Redis TTL?** (Background thread deletes documents past a date
    field; coarser/less precise than Redis key expiry; runs ~every 60s.)

12. **How would you approach schema migration in MongoDB given there's no ALTER
    TABLE?** (Lazy migration on read/write, background backfill jobs, versioned
    documents with a schemaVersion field, dual-read/dual-write during transition.)

---

## 3. The Cache-Aside Pattern

### The principle

Cache-aside (also called lazy loading) is a caching strategy where the
*application* — not the cache or the database — orchestrates the caching logic. On
a read, the app checks the cache first; on a miss, it loads from the database and
populates the cache. The cache sits "aside" the main data path; it isn't in the
line between app and database, the app just consults it. This is the strategy the
Catalog service uses with Redis in front of MongoDB.

### The minute sub-concepts

**The read algorithm, precisely.** (1) Look up the key in the cache. (2) On a HIT,
return the cached value — the database is never touched. (3) On a MISS, query the
database, write the result into the cache with a TTL, and return it. The next read
of that key is a hit until it expires or is invalidated.

**The write algorithm.** Cache-aside writes go to the database (the source of
truth) and then *invalidate* (delete) the affected cache entries, so the next read
re-populates fresh. Deleting rather than updating the cache is deliberate — it's
simpler and avoids a class of races where a stale in-flight write clobbers a newer
value.

**Why invalidate instead of write-through the cache.** You could update the cache
on write too. But that introduces the "write-write race": two concurrent updates
can interleave so the cache ends holding the older value. Deleting the key
sidesteps this — whoever reads next reloads the current DB value. The cost is one
guaranteed cache miss after each write.

**TTL as a safety net.** Every cached entry gets a time-to-live. Even if
invalidation logic has a bug or a write path forgets to invalidate, the cache
self-heals within TTL — stale data can only persist for at most the TTL. TTL turns
correctness bugs into bounded-staleness bugs, which is a huge operational win.

**Cache miss penalty and cold cache.** A miss costs more than no cache at all: you
pay the cache lookup *plus* the DB query *plus* the cache write. A freshly started
(cold) cache is all misses, so a service can be briefly slower and hit the DB
harder right after deploy — worth knowing for capacity planning.

**Stale reads (the consistency window).** Between a DB write and the corresponding
cache invalidation, or within the TTL if you rely only on TTL, readers can see
stale data. Cache-aside is therefore *eventually consistent* for cached reads. You
choose the staleness you can tolerate via TTL length and how aggressively you
invalidate.

**Thundering herd / cache stampede.** When a popular key expires, many concurrent
requests all miss simultaneously and all hit the database at once — a stampede that
can overwhelin the DB. Mitigations: (a) a short lock/mutex so only one request
recomputes while others wait, (b) "early recomputation" (refresh slightly before
expiry), (c) request coalescing, (d) staggered/jittered TTLs so keys don't all
expire together.

**Cache penetration.** Repeated requests for keys that *don't exist* always miss
and always hit the DB (the cache never populates because there's nothing to cache).
An attacker can exploit this. Mitigations: cache a negative/empty marker with a
short TTL, or use a Bloom filter to reject known-absent keys before the DB.

**Cache avalanche.** If a large set of keys share the same TTL and expire at the
same instant (e.g. everything cached at startup with a 60s TTL), you get a mass
simultaneous stampede. Mitigation: add random jitter to TTLs so expiry is spread
over time.

**Graceful degradation.** A correct cache-aside implementation treats the cache as
optional: if Redis is down, reads fall through to the database and the service
keeps working (slower). The catalog code wraps every cache call in try/catch and
logs-and-continues on failure — the cache can never take the service down. This is
why the catalog's readiness probe fails only if *Mongo* is down, not if Redis is.

**Comparison to other strategies.** *Read-through/write-through*: the cache library
sits inline and loads/writes the DB itself (app talks only to the cache).
*Write-behind (write-back)*: writes go to the cache and are flushed to the DB
asynchronously — fast writes, risk of loss. Cache-aside is the most common because
it's simple, resilient (cache optional), and puts control in the app.

### Practical worked example

The read path from the catalog repository, annotated:

```typescript
async function getProductBySku(sku) {
  const key = `catalog:product:${sku}`;

  // 1. Check cache.
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);   // 2. HIT — DB untouched.

  // 3. MISS — load source of truth.
  const product = await products().findOne({ sku });
  if (!product) return null;

  // 4. Populate cache with a TTL, then return.
  await redis.set(key, JSON.stringify(product), 'EX', 60);
  return product;
}
```

The write path — update the DB, then invalidate both the single-item key and the
category-list key that could now be stale:

```typescript
async function updatePrice(sku, priceCents) {
  const updated = await products().findOneAndUpdate(
    { sku }, { $set: { priceCents } }, { returnDocument: 'after' }
  );
  // Invalidate — next read reloads fresh from Mongo.
  await redis.del(`catalog:product:${sku}`, `catalog:category:${updated.category}`);
  return updated;
}
```

A stampede-safe refinement (conceptual) using a short lock so only one caller
recomputes a hot expired key:

```typescript
// On miss, try to acquire a short lock; if you get it, recompute and populate.
// If you don't, briefly wait and re-read the cache (someone else is populating).
const gotLock = await redis.set(`lock:${key}`, "1", "NX", "EX", 5);
if (gotLock) { /* recompute + populate + release */ }
else { await sleep(50); return getProductBySku(sku); /* re-check cache */ }
```

You can *observe* cache-aside working in this project: the first GET of a product
is a MISS (logs show it, and it queries Mongo); immediately GET it again and it's a
HIT (served from Redis, Mongo untouched). PATCH the price and the next GET is a
MISS again — proof the write invalidated the entry.

### 10 senior interview questions

1. **Describe the cache-aside read and write algorithms step by step, including
   exactly when the database is and isn't touched.** (Read: check→hit returns/
   miss loads+populates; write: DB then invalidate.)

2. **Why does cache-aside invalidate (delete) on write instead of updating the
   cached value? What race does deletion avoid?** (Write-write interleaving that
   leaves a stale value; deletion forces a fresh reload.)

3. **What is a cache stampede / thundering herd, and give three distinct
   mitigations with their trade-offs.** (Lock/mutex, early refresh, TTL jitter,
   request coalescing; each trades latency/complexity for DB protection.)

4. **Explain cache penetration and how it differs from a stampede. How do you
   defend against it?** (Requests for nonexistent keys always miss; cache negative
   results with short TTL or use a Bloom filter.)

5. **Explain cache avalanche and the role of TTL jitter.** (Mass simultaneous
   expiry; randomize TTLs to spread expiry over time.)

6. **What consistency guarantee does cache-aside provide for cached reads, and how
   do you tune the staleness window?** (Eventual consistency; shorter TTL + prompt
   invalidation shrinks the window at the cost of more misses/DB load.)

7. **Your cache goes down entirely at peak traffic. Describe what should happen in
   a well-designed cache-aside system and what could go wrong in a bad one.**
   (Good: fall through to DB, degraded but up. Bad: readiness tied to cache, or no
   fallback → outage; also DB may be undersized for full uncached load.)

8. **Compare cache-aside, read-through, write-through, and write-behind. When would
   you choose each?** (Aside: simple/resilient/app-controlled. Through: transparent
   but cache inline. Write-behind: fast writes, durability risk.)

9. **How do you choose a TTL? What factors push it longer vs. shorter?** (Tolerable
   staleness, data change rate, DB load capacity, hit-rate goals; volatile data →
   shorter, stable data → longer.)

10. **How would you invalidate a cached *list* (e.g. products in a category) when a
    single member changes, and what are the options and costs?** (Delete the list
    key; or maintain finer-grained keys; trade-off between invalidation precision
    and key-management complexity.)

11. **A colleague caches with no TTL and relies purely on invalidation. What's the
    risk and why is TTL still recommended as a backstop?** (Any missed invalidation
    → permanently stale data; TTL bounds staleness even when invalidation has bugs.)

12. **How do you measure whether a cache is actually helping? Which metrics matter
    and what hit-rate is "good"?** (Hit ratio, latency percentiles with/without,
    DB load reduction; "good" is workload-dependent — a low hit rate may mean the
    cache is missized or the access pattern isn't cacheable.)

---

## 4. Redis as a Primary Datastore

### The principle

Redis is usually introduced as a cache, but it can be the *primary* datastore —
the source of truth — for the right data. The Cart service does exactly this: carts
live only in Redis, nowhere else. This works when the data is a good fit for
Redis's model (key-accessed, structure-friendly), and when Redis's durability
trade-offs are acceptable for that data. Carts qualify: they're ephemeral,
key-scoped, high-churn, and tolerably lossy.

### The minute sub-concepts

**In-memory with optional persistence.** Redis holds all data in RAM, which is why
it's microsecond-fast. It persists to disk only so it can *recover* after restart —
the working set always lives in memory. This is the fundamental trade: speed and
simplicity, bounded by available RAM.

**The single-threaded command execution model.** Redis executes commands on a
single thread (for the data path). This sounds like a limitation but is a strength:
every command is atomic with respect to others — no locks, no race conditions
between commands. `HINCRBY` can't interleave with another `HINCRBY` on the same
key. The trade-off: a single slow command (e.g. `KEYS *` on a huge keyspace) blocks
everything, so you avoid O(n) commands in production.

**Data structures, not just strings.** Redis's power is native data types: Strings,
Hashes (field→value maps — used for carts), Lists, Sets, Sorted Sets (scored,
ordered — great for leaderboards/rate limiting), Bitmaps, HyperLogLog, Streams
(append-only logs for messaging). Choosing the right structure is the equivalent of
schema design. Carts use a Hash because a cart *is* a map of SKU→quantity.

**Key design.** Since Redis is a key-value store, key naming *is* your data model.
Conventions: namespace with colons (`cart:user-42`), keep keys predictable and
constructable from the data you have, avoid unbounded key growth. Good key design
lets you locate, expire, and reason about data without scanning.

**TTL and expiry mechanics.** Redis can expire keys automatically. Expiry is
enforced two ways: *lazily* (when a key is accessed, if expired it's removed) and
*actively* (a background job samples keys periodically and evicts expired ones).
This is why TTL is precise enough for carts and sessions. `EXPIRE`/`PEXPIRE` set
it; refreshing it on each interaction gives a "sliding window" (used for carts).

**Persistence modes: RDB vs AOF.** *RDB* takes point-in-time snapshots of the whole
dataset at intervals — compact, fast restart, but you can lose everything since the
last snapshot on a crash. *AOF* (append-only file) logs every write operation;
replaying it rebuilds state — far less data loss (down to ~1 second with
`everysec`), but larger files and slightly slower. You can run both. The Cart Redis
uses AOF because it's the source of truth; the Catalog cache Redis uses neither
(it's just a cache — losing it only causes misses).

**Eviction policies.** When Redis hits its memory limit, `maxmemory-policy` decides
what happens: `noeviction` (reject writes — correct for a primary store you don't
want silently losing data), `allkeys-lru`/`allkeys-lfu` (evict least-recently/
frequently-used — correct for a *cache*), `volatile-*` (evict only keys with a
TTL). The Catalog cache uses `allkeys-lru` (evicting is fine); a cart store should
*not* use an evicting policy, because evicting a cart is data loss.

**Durability is weaker than a relational DB — and that must drive what you store.**
Even with AOF `everysec`, a crash can lose ~1 second of writes. For carts, losing a
second of "add to cart" clicks is acceptable. For orders and payments it is not —
which is precisely why those use Postgres. Matching durability requirements to
store is the whole polyglot argument, seen from the durability angle.

**Atomicity, transactions, and Lua.** Single commands are atomic. For multi-command
atomicity, Redis offers `MULTI/EXEC` transactions (queued commands executed
together, though without rollback semantics) and Lua scripts (executed atomically
on the single thread). These let you do compound operations — like "check stock and
decrement if available" — without races.

**Replication and high availability.** A single Redis is a single point of failure.
Production uses replicas (async replication) plus Redis Sentinel (automatic
failover) or Redis Cluster (sharding + HA). Async replication means a failover can
lose the last few writes — another durability nuance you accept per-workload.

### Practical worked example

The cart as a Redis Hash, with atomic increment and sliding-window expiry:

```
# Add one SHIRT-001 to user 42's cart, atomically:
HINCRBY cart:user-42 SHIRT-001 1
# Refresh the 24h expiry on every interaction (sliding window):
EXPIRE  cart:user-42 86400
# Read the whole cart:
HGETALL cart:user-42        # → { SHIRT-001: "1", BOOK-001: "2" }
# Remove one line:
HDEL    cart:user-42 SHIRT-001
# Clear on checkout:
DEL     cart:user-42
```

Why a Hash and not, say, a JSON string in a plain key? Because with a Hash you can
increment a single item atomically (`HINCRBY`) without read-modify-write of the
whole cart — no race between two concurrent "add" clicks. A JSON blob would require
GET → parse → modify → SET, which two clients can interleave and lose an update.

The persistence choice, expressed in the compose command lines:

```yaml
# Cart Redis — PRIMARY store → durability matters → AOF on:
command: ["redis-server", "--appendonly", "yes"]

# Catalog Redis — just a cache → losing it is fine → allow LRU eviction:
command: ["redis-server", "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]
```

Those two lines encode the entire "cache vs. primary store" distinction: the cache
may evict under pressure and needs no persistence; the primary store must not evict
and persists via AOF.

An atomic "check-and-decrement stock" with a Lua script (the kind of thing the
Inventory service will use in Phase 3), illustrating multi-step atomicity:

```lua
-- Returns 1 if decremented, 0 if insufficient stock. Runs atomically.
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock >= tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 1
end
return 0
```

### 10 senior interview questions

1. **Redis is single-threaded for command execution. Explain why that's a feature,
   not just a limitation, and what operational rule it implies.** (Atomic commands,
   no locks; implies avoiding O(n) blocking commands like `KEYS` in prod — use
   `SCAN`.)

2. **When is it appropriate to use Redis as a primary datastore rather than a
   cache? Give the criteria and a counter-example.** (Ephemeral, key-accessed,
   loss-tolerant, structure-fitting data → yes; durable financial records → no.)

3. **Compare RDB and AOF persistence: mechanism, data-loss window, restart speed,
   file size. When would you use each or both?** (Snapshot vs. op-log; RDB loses
   since last snapshot, AOF ~1s; RDB faster restart/smaller; both for belt-and-
   suspenders.)

4. **Walk through Redis eviction policies. Which is correct for a cache vs. a
   primary store, and why is the wrong choice dangerous?** (allkeys-lru for cache;
   noeviction for primary store; evicting a primary store = silent data loss.)

5. **Why model a cart as a Hash rather than a serialized JSON string? What
   concurrency bug does the Hash avoid?** (HINCRBY is atomic; JSON blob needs
   read-modify-write which races and loses concurrent updates.)

6. **Explain lazy vs. active expiry in Redis and the implications for relying on
   TTL for correctness.** (Lazy on access + active sampling; a key may briefly
   exist past expiry until accessed/sampled — usually fine, occasionally matters.)

7. **How do you achieve multi-command atomicity in Redis, and what are the
   differences between MULTI/EXEC and Lua scripting?** (MULTI queues without
   rollback; Lua runs atomically on the thread and can branch on values; Lua for
   conditional logic like check-and-decrement.)

8. **Describe Redis high-availability options and the data-loss implications of
   async replication during failover.** (Sentinel for failover, Cluster for
   sharding+HA; async replication can lose last writes on failover.)

9. **You need a sliding-window session/cart expiry. How do you implement it and
   what command refreshes the window?** (Set TTL on write; call EXPIRE on every
   interaction to slide it.)

10. **A single Redis command is making your latency spike intermittently. How do
    you diagnose and fix it given the single-threaded model?** (SLOWLOG, look for
    O(n) commands / big keys; replace KEYS with SCAN, break up big keys, avoid
    large-value ops on the hot path.)

11. **How would you design keys and structures for a rate limiter in Redis?**
    (Sorted set of timestamps or fixed/sliding window counters with INCR+EXPIRE;
    atomic via Lua; per-identity keys.)

12. **Redis holds everything in RAM. How do you plan capacity and what happens as
    you approach the memory ceiling under each eviction policy?** (Size the working
    set + overhead; at ceiling, noeviction rejects writes, allkeys-lru evicts;
    monitor used_memory, fragmentation, and evicted_keys.)

---
---

# Phase 3 — Concept Deep-Dives

Five concepts underpin the checkout saga, each covered with mechanics, worked
examples, and senior-level interview Q&A:

5. The Saga pattern (orchestration vs choreography, compensation)
6. The Transactional Outbox pattern (the dual-write problem)
7. Idempotency (why every consumer must handle duplicates)
8. Message delivery semantics (at-least-once, at-most-once, "exactly-once")
9. Dead-letter queues (handling poison messages)

---

## 5. The Saga Pattern

### The principle

A saga is a way to manage a transaction that spans multiple services, each with
its own database, when you cannot use a single ACID transaction across them. It
breaks the overall business transaction into a sequence of local transactions,
one per service. If any step fails, the saga runs compensating transactions that
semantically undo the local transactions that already succeeded. In this platform,
checkout is a saga across Order, Inventory, and Payment.

The saga pattern exists because of a hard constraint: in a microservices system
with database-per-service, there is no distributed ACID transaction you can wrap
around "reserve stock AND charge the card AND confirm the order." Those live in
three different databases owned by three different services. The saga is the
industry-standard answer to "how do I keep these consistent without a distributed
transaction."

### The minute sub-concepts

**Local transaction + compensating transaction.** Each step of a saga is a local
ACID transaction within one service's own database (e.g. inventory decrements
stock in its Postgres, atomically). For every local transaction that has a
side-effect you might need to undo, you define a *compensating transaction* that
semantically reverses it. Reserving stock is compensated by releasing stock.
Charging a card is compensated by refunding it. Note "semantically": you can't
literally roll back a committed transaction in another service, so you issue a new
transaction that undoes its effect.

**Compensation is not rollback.** A database rollback erases a transaction as if it
never happened. A compensating transaction is a *new* forward action that
counteracts a *committed* one — it's visible in history. If you reserved then
released stock, both events happened; the net effect is zero, but there's a trail.
This distinction matters for auditing and for effects that can't be perfectly
undone (you can refund a charge, but the customer saw the charge on their
statement).

**Orchestration vs choreography — the two coordination styles.** In
*orchestration*, one central coordinator (here, the Order service) explicitly
tells each participant what to do and reacts to the results: "reserve inventory" →
got reserved → "charge payment" → got failed → "release inventory." The saga logic
lives in one place. In *choreography*, there is no coordinator; each service
listens for events and reacts, emitting its own events: inventory hears
"order.created," reserves, emits "inventory.reserved"; payment hears that, charges,
emits its result. The flow is distributed across services. This platform uses
orchestration.

**Why we chose orchestration.** Orchestration centralizes the saga logic, making
the flow explicit, easy to follow, easy to change, and easy to trace (you can look
at the Order service and see the whole checkout). Its downside is a central
coordinator that every step depends on. Choreography is more decoupled but the
flow is scattered — to understand checkout you'd read four services — and it's
prone to hidden cyclic dependencies and "event storms." For a flow with clear
sequential steps and compensation, orchestration is usually the clearer choice, and
being able to articulate the trade-off is the senior signal.

**The saga is a state machine.** The orchestrator persists the order's state at
every transition (PENDING → AWAITING_PAYMENT → CONFIRMED, or → REJECTED, or →
FAILED). This persisted state is essential: if the orchestrator crashes and
restarts, it can resume or at least report where the saga got to. State that lived
only in memory would be lost on restart, stranding the order.

**Sagas are eventually consistent, not immediately consistent.** During a saga the
system is temporarily inconsistent — stock is reserved but payment hasn't
completed; the order is PENDING but not yet CONFIRMED. The guarantee is that the
system *converges* to a consistent end state (CONFIRMED with stock committed, or
FAILED with stock released). Consumers of this data must tolerate the in-between
states. This is the fundamental trade you accept for avoiding distributed
transactions.

**Failure of a compensation is the hard case.** What if releasing inventory *also*
fails? Compensations must themselves be retryable and idempotent, and truly stuck
compensations need alerting/manual intervention. A saga framework or careful design
ensures compensations are retried until they succeed. This is why compensation
events flow through the same reliable messaging + idempotency machinery as forward
events.

**Isolation is not provided — the "dirty read" problem.** ACID's "I" (isolation)
is absent across a saga. Because intermediate states are visible, another
transaction can read data mid-saga (e.g. see stock as reserved). Techniques to
mitigate: semantic locks (a "pending" status field that signals "don't touch"),
commutative updates, and reordering steps so the riskiest/most-likely-to-fail step
runs first (fail fast before doing more work). Our saga reserves inventory first
(cheap to compensate) before charging payment.

### Practical worked example

The happy path and the compensation path in your Order service, expressed as the
state machine:

```
POST /orders  → order PENDING, outbox: "order.created"
                        │
             inventory reserves stock
              ┌─────────┴──────────┐
        reserved                rejected (out of stock)
              │                      │
   order AWAITING_PAYMENT      order REJECTED (terminal)
              │
        payment charges
      ┌───────┴────────┐
  succeeded          failed
      │                 │
 order CONFIRMED   COMPENSATE: emit "inventory.release"
   (terminal)           → order FAILED (terminal)
```

The compensation trigger in code (from the Order orchestrator):

```typescript
async function onPaymentFailed(evt) {
  // Payment failed AFTER stock was reserved. Compensate by releasing the stock,
  // and move the order to FAILED. Both happen atomically via the outbox.
  await enqueueCompensation(evt.orderId, 'inventory.release', {
    orderId: evt.orderId, items: evt.items,
  });
}
```

And the inventory service applying the compensation:

```typescript
// Consuming "inventory.release" — the compensating transaction.
async function releaseForOrder(evt) {
  // Add the units back to available, decrement reserved. A new forward
  // transaction that semantically undoes the earlier reservation.
  for (const line of evt.items) {
    await client.query(
      `UPDATE stock SET available = available + $2, reserved = reserved - $2 WHERE sku = $1`,
      [line.sku, line.quantity]);
  }
}
```

You can demo both paths deterministically: an order for `BOOK-001` runs
PENDING → AWAITING_PAYMENT → CONFIRMED. An order for `LAPTOP-001` (the configured
fail-SKU) runs PENDING → AWAITING_PAYMENT → payment fails → inventory released →
FAILED. An order for more `LAPTOP-001` units than the 2 in stock runs
PENDING → REJECTED (the out-of-stock path, no payment attempted).

### 10 senior interview questions

1. **What problem does the saga pattern solve, and why can't you just use a
   distributed transaction?** (No practical cross-service ACID/2PC in
   database-per-service systems; saga = sequence of local transactions with
   compensation.)

2. **Distinguish orchestration from choreography. Give the trade-offs and when
   you'd pick each.** (Central coordinator vs event reactions; orchestration is
   explicit/traceable/changeable but has a coordinator dependency; choreography is
   decoupled but scattered and cycle-prone.)

3. **Explain the difference between a rollback and a compensating transaction.**
   (Rollback erases an uncommitted tx; compensation is a new forward tx that undoes
   a committed one, visible in history, and may be imperfect.)

4. **A saga has no isolation. What problems does that cause and how do you
   mitigate them?** (Dirty reads of intermediate state; mitigate with semantic
   locks/pending flags, commutative updates, ordering risky steps first.)

5. **What happens if a compensating transaction itself fails? How do you design for
   that?** (Compensations must be retryable and idempotent; retry until success;
   alert on stuck compensations for manual intervention.)

6. **Why persist saga state, and what breaks if you keep it only in memory?**
   (Crash recovery/resumption and status reporting; in-memory state is lost on
   restart, stranding in-flight sagas.)

7. **In what order should saga steps run, and why?** (Riskiest/most-likely-to-fail
   and cheapest-to-compensate first — fail fast before doing expensive work; e.g.
   reserve inventory before charging.)

8. **How does a saga relate to eventual consistency, and what must downstream
   consumers tolerate?** (System is temporarily inconsistent and converges; readers
   must handle intermediate/pending states.)

9. **Compare a saga to a two-phase commit (2PC). Why are sagas generally preferred
   in microservices?** (2PC blocks/locks across services and has a coordinator
   single-point-of-failure and poor availability; sagas are non-blocking and
   partition-tolerant at the cost of isolation.)

10. **Walk through designing the compensation for a step that charged a customer's
    card. What are the real-world complications?** (Refund as compensation;
    complications: fees, partial refunds, the customer already saw the charge,
    idempotent refund handling, async settlement timing.)

11. **When would you introduce a saga orchestration framework (e.g. Temporal,
    Camunda, AWS Step Functions) instead of hand-rolling?** (When you need durable
    execution, retries, timeouts, visibility, and complex branching at scale;
    hand-rolled is fine for simple, few-step sagas.)

12. **How do timeouts fit into a saga? What happens if a participant never
    responds?** (Each step needs a timeout; on timeout you either retry or treat it
    as failure and compensate; the orchestrator must not wait forever.)

---

## 6. The Transactional Outbox Pattern

### The principle

The transactional outbox solves the "dual write" problem: when a service must both
update its database AND publish a message about that change, and both must happen
reliably together. You cannot wrap a database transaction and a message-broker
publish in one atomic operation — they're different systems. The outbox pattern
makes them atomic by writing the message into an "outbox" table *within the same
database transaction* as the business change, then relaying those rows to the
broker separately.

### The minute sub-concepts

**The dual-write problem, precisely.** Consider: create an order row, then publish
"order.created." Two failure modes if done naively. (a) You commit the order, then
crash before publishing → the order exists but the saga never starts; the order is
stuck forever. (b) You publish, then crash before committing the order → a saga
runs for an order that doesn't exist. Either way, DB state and published events
disagree. There's no ordering of "write DB" and "publish" that's safe, because
there's no atomic boundary spanning both systems.

**The core mechanism.** Within the single DB transaction that makes the business
change, also INSERT a row into an `outbox` table describing the event. Because
it's the same transaction, the business change and the outbox row commit together
atomically — either both land or neither does. Now the event's existence is exactly
as reliable as the business change itself.

**The relay (message relay / publisher).** A separate process reads unpublished
rows from the outbox and publishes them to the broker, marking each published
afterward. This decouples "recording the intent to publish" (atomic with the
business change) from "actually publishing" (which can retry independently). In
this platform the Order service runs a polling relay loop every second.

**Two ways to implement the relay.** *Polling* (what we use): the relay repeatedly
queries `SELECT ... WHERE published = FALSE` and publishes. Simple, works anywhere,
at the cost of polling latency and DB load. *Change Data Capture (CDC)*: a tool
like Debezium tails the database's write-ahead log and streams outbox inserts to
the broker with no polling. More efficient and lower-latency at scale, but more
infrastructure. Knowing both, and when each fits, is the senior answer.

**At-least-once, therefore idempotency downstream.** The relay might publish a
message and then crash before marking it published; on restart it republishes.
So the outbox guarantees *at-least-once* delivery — every event is delivered one or
more times, never zero. This is precisely why every consumer in the saga must be
idempotent. The outbox and idempotency are complementary halves of reliable
messaging.

**Ordering considerations.** If event order matters, the relay should publish in
insertion order (we `ORDER BY created_at`). With multiple relay instances or
partitioned processing you must be careful not to reorder related events; often
you key ordering by an aggregate id.

**Why not just publish inside the transaction?** Because the broker publish isn't
part of the DB transaction — if the DB commits and the publish call then fails (or
vice versa), you're back to the dual-write problem. The publish must happen *after*
commit, driven by the durably-recorded outbox row, not inline.

**Cleanup.** Published outbox rows accumulate. Production systems periodically
delete or archive old published rows (or use a partitioned table) to keep the
outbox small and the "unpublished" index efficient.

### Practical worked example

Creating an order and its event atomically (from the Order service):

```typescript
await client.query('BEGIN');
// 1. The business change.
const orderId = (await client.query(
  'INSERT INTO orders (user_id, status, total_cents) VALUES ($1,$2,$3) RETURNING id',
  [userId, 'PENDING', total])).rows[0].id;
// 2. The outbox row — SAME transaction, so it commits atomically with the order.
await client.query(
  'INSERT INTO outbox (routing_key, payload) VALUES ($1, $2)',
  ['order.created', JSON.stringify({ orderId, items })]);
await client.query('COMMIT');   // order + event intent commit together
```

The relay loop that publishes committed outbox rows:

```typescript
async function tick() {
  const { rows } = await pool.query(
    'SELECT id, routing_key, payload FROM outbox WHERE published = FALSE ORDER BY created_at LIMIT 20');
  for (const row of rows) {
    publish(row.routing_key, row.payload);            // to RabbitMQ
    await pool.query('UPDATE outbox SET published = TRUE WHERE id = $1', [row.id]);
  }
  setTimeout(tick, 1000);   // poll again
}
```

If the process crashes between `publish` and the `UPDATE`, the row is still
`published = FALSE`, so next tick republishes it — at-least-once, handled by
idempotent consumers.

### 10 senior interview questions

1. **Describe the dual-write problem and the two distinct failure modes it
   produces.** (DB-then-publish crash loses the event; publish-then-DB crash emits
   an event for nonexistent data; no safe ordering across two systems.)

2. **How does the outbox pattern make a DB write and an event publish atomic?**
   (Insert the event into an outbox table within the same DB transaction; a
   separate relay publishes committed rows.)

3. **Compare polling-based and CDC-based outbox relays. Trade-offs?** (Polling:
   simple, portable, polling latency + DB load. CDC/Debezium: low-latency, no
   polling, more infra and operational complexity.)

4. **Why does the outbox pattern imply at-least-once delivery, and what does that
   require of consumers?** (Relay may republish after a crash; consumers must be
   idempotent to tolerate duplicates.)

5. **A colleague publishes to the broker inside the DB transaction to "keep it
   simple." What's wrong with that?** (The publish isn't transactional; commit
   succeeds but publish can fail, or vice versa — the exact dual-write problem the
   outbox avoids.)

6. **How do you preserve event ordering with an outbox, and where can ordering
   break?** (Publish in insertion order; ordering breaks with concurrent relays or
   partitioned consumers; key ordering by aggregate id.)

7. **How do you prevent the outbox table from growing unbounded?** (Periodic
   delete/archival of published rows, partitioning, a partial index on
   unpublished rows.)

8. **Two relay instances run for HA. What can go wrong and how do you coordinate
   them?** (Double-publishing/reordering; use row locking `FOR UPDATE SKIP LOCKED`,
   leader election, or partition the outbox so each instance owns a slice.)

9. **How does the outbox pattern relate to the saga pattern in this system?** (The
   saga's forward and compensating events are all emitted via the outbox so state
   changes and their events are atomic and reliably delivered.)

10. **What's the "inbox" pattern and how does it complement the outbox?**
    (A consumer-side dedup table recording processed message ids to make
    consumption idempotent — the receiving-side counterpart to the outbox.)

11. **Could you use CDC alone without an explicit outbox table? What are the
    downsides?** (Yes — stream domain-table changes directly — but you lose control
    over event shape/routing and couple event schema to table schema; an explicit
    outbox gives clean, intentional events.)

12. **How would you test that the outbox guarantees no lost events under crashes?**
    (Fault injection: kill the process between commit and publish, and between
    publish and mark-published; assert every committed business change eventually
    produces exactly-effect-once downstream via idempotency.)

---

## 7. Idempotency

### The principle

An operation is idempotent if performing it multiple times has the same effect as
performing it once. In distributed messaging, idempotency is what makes
at-least-once delivery safe: because a message may be delivered more than once,
every consumer must be able to process a duplicate without causing a duplicate
side-effect (double-charging, double-reserving stock, double-shipping). In this
platform, every saga participant is idempotent.

### The minute sub-concepts

**Why duplicates are inevitable.** At-least-once delivery — from the outbox relay,
from broker redelivery of unacked messages, from consumer retries — means the same
logical event can arrive twice. Network partitions and timeouts also cause clients
to retry requests they're unsure completed. You cannot prevent duplicates in a
distributed system; you must design to absorb them. "Just make delivery
exactly-once" is not a real option (see the next concept).

**Idempotency key.** The standard mechanism: attach a unique key to each operation
(here, the order id serves as the key). Before performing the side-effect, check
whether that key has already been processed; if so, return the previous result
instead of re-doing the work. The key must be stable across retries of the *same*
logical operation and unique across *different* operations.

**Natural vs synthetic idempotency.** Some operations are *naturally* idempotent:
`SET status = 'CONFIRMED'` produces the same state no matter how many times you run
it. Others are not: `balance = balance - 10` (a relative update) double-applies on
a duplicate. For non-idempotent operations you add *synthetic* idempotency via a
key + a processed-record check, converting them to effectively-once.

**Enforcement via a unique constraint.** The most robust implementation uses the
database. A UNIQUE constraint on the idempotency key means a duplicate insert
*fails at the database level* (a unique-violation), which you catch and treat as
"already processed." This is race-safe even under concurrent duplicate deliveries,
because the database serializes the constraint check. Our Payment service does
exactly this: `idempotency_key UNIQUE` on the payments table.

**The processed-events table (inbox).** A common pattern is a table recording every
processed message/operation id. The consumer, in one transaction, checks-and-records
the id and performs the side-effect. A duplicate finds the id already present and
skips. Our Inventory service uses `processed_reservations` keyed by order id.

**Atomicity of check-and-act.** The check ("have I seen this key?") and the act
("perform and record") must be atomic, or two concurrent duplicates can both pass
the check and both act. Achieve this with a single DB transaction, or by relying on
the unique-constraint violation as the serialization point. A naive "SELECT then
INSERT" without a transaction or constraint has a race window.

**Idempotency has a time/space cost.** You must store processed keys somewhere, and
decide how long to keep them (forever is simplest but grows unbounded; a TTL risks
a very-late duplicate slipping through). The retention window should exceed the
maximum realistic redelivery delay.

**Idempotency vs deduplication.** Related but distinct: dedup filters out duplicate
*messages* (often by message id at the broker or a dedup cache). Idempotency makes
the *operation* safe regardless of duplicates. Dedup is an optimization; idempotency
is the correctness guarantee you can't skip.

### Practical worked example

Payment idempotency via a unique constraint (from the Payment service):

```typescript
// The order id is the idempotency key. If we've already charged this order,
// return the prior result instead of charging again.
const existing = await pool.query(
  'SELECT status FROM payments WHERE idempotency_key = $1', [evt.orderId]);
if (existing.rows[0]) return existing.rows[0].status;   // idempotent short-circuit

// Otherwise attempt the insert. The UNIQUE constraint on idempotency_key makes a
// concurrent duplicate fail with 23505, which we catch and treat as already-done.
try {
  await pool.query(
    'INSERT INTO payments (idempotency_key, amount_cents, status) VALUES ($1,$2,$3)',
    [evt.orderId, amount, status]);
} catch (err) {
  if (err.code === '23505') {   // unique_violation → a duplicate won the race
    const row = await pool.query('SELECT status FROM payments WHERE idempotency_key = $1', [evt.orderId]);
    return row.rows[0].status;
  }
  throw err;
}
```

Inventory idempotency via a processed-events table:

```typescript
await client.query('BEGIN');
const seen = await client.query(
  'SELECT outcome FROM processed_reservations WHERE order_id = $1', [evt.orderId]);
if (seen.rows[0]) { await client.query('COMMIT'); return seen.rows[0].outcome; } // no-op
// ... perform the reservation, then record it, all in this transaction ...
await client.query('INSERT INTO processed_reservations (order_id, outcome) VALUES ($1,$2)', [evt.orderId, outcome]);
await client.query('COMMIT');
```

You can demonstrate idempotency by replaying the same event: the second processing
finds the recorded key and does nothing, so stock isn't double-reserved and the
card isn't double-charged.

### 10 senior interview questions

1. **Define idempotency and explain why it's mandatory with at-least-once
   delivery.** (Same effect no matter how many times applied; at-least-once means
   duplicates happen, so consumers must absorb them safely.)

2. **What is an idempotency key, and what properties must it have?** (A stable
   unique id for a logical operation; stable across retries of the same operation,
   unique across different operations.)

3. **Distinguish naturally idempotent operations from ones needing synthetic
   idempotency. Give an example of each.** (Absolute `SET status='X'` vs relative
   `balance = balance - 10`; the latter needs a key + processed-check.)

4. **Why is a database UNIQUE constraint a robust way to enforce idempotency, and
   what race does it close?** (The DB serializes the constraint check; concurrent
   duplicates can't both insert — one gets a unique-violation — closing the
   SELECT-then-INSERT race.)

5. **Walk through the race in a naive "SELECT if not processed, then INSERT and
   act" without a transaction. How do you fix it?** (Two duplicates both pass the
   SELECT and both act; fix with a single transaction and/or a unique constraint as
   the serialization point.)

6. **How long should you retain idempotency keys, and what's the risk of expiring
   them too soon?** (Longer than the max realistic redelivery/retry window; too
   short and a late duplicate slips through and re-applies.)

7. **Differentiate idempotency from message deduplication. Is dedup sufficient?**
   (Dedup filters duplicate messages; idempotency makes the operation safe. Dedup
   is best-effort/optimization; idempotency is the correctness guarantee.)

8. **Design idempotent handling for "charge a customer" across retries triggered by
   client timeouts.** (Client sends a stable idempotency key; server records it
   with the charge under a unique constraint; retries return the original result,
   never a second charge.)

9. **How do you make a compensating transaction idempotent, and why does it
   matter?** (Key the compensation by the same operation id; releasing stock twice
   must not over-credit; record that the release happened.)

10. **What's the "inbox pattern" and how does it implement consumer idempotency?**
    (A processed-messages table; check-and-record the message id in the same
    transaction as the side-effect so duplicates are skipped.)

11. **Can you achieve idempotency without storing state? When and how?** (Only if
    the operation is naturally idempotent — absolute sets, upserts,
    max/min-style merges; otherwise you must store processed keys.)

12. **A downstream API you call isn't idempotent and has no idempotency-key
    support. How do you protect against duplicates?** (Wrap it: record your own
    processed-key before/around the call, use a dedup store, or make the call
    conditional; accept that true safety requires cooperation or careful
    at-most-once handling with reconciliation.)

---

## 8. Message Delivery Semantics

### The principle

Delivery semantics describe the guarantee a messaging system gives about how many
times a message is delivered to a consumer: at-most-once, at-least-once, or
exactly-once. Understanding which guarantee you have — and which you can actually
achieve — determines whether your consumers need to be idempotent and how you
handle failures. This platform uses at-least-once delivery, which is why every
consumer is idempotent.

### The minute sub-concepts

**At-most-once.** Each message is delivered zero or one time — never duplicated,
but possibly lost. You get this by acknowledging a message *before* processing it
(or using fire-and-forget with no ack): if the consumer crashes after ack but
before finishing, the message is gone. Use when occasional loss is acceptable and
duplicates are worse than loss (e.g. high-volume metrics where one dropped sample
doesn't matter). No idempotency needed, but no delivery guarantee either.

**At-least-once.** Each message is delivered one or more times — never lost, but
possibly duplicated. You get this by acknowledging *after* successful processing: if
the consumer crashes before acking, the broker redelivers. This is the default for
reliable systems and what we use. It requires idempotent consumers to make
duplicates harmless. The combination "at-least-once delivery + idempotent
processing" yields *effectively-once* results, which is what people usually
actually want.

**Exactly-once delivery is essentially a myth (at the transport level).** True
exactly-once *delivery* — the message hits the consumer once and only once, with no
loss and no duplication, across arbitrary failures — is impossible to guarantee in
a distributed system with independent failures (this ties to the Two Generals
problem). The moment there's a network that can drop the acknowledgment, the sender
can't know whether to resend. So systems that claim "exactly-once" almost always
mean exactly-once *processing/effects*, achieved by at-least-once delivery plus
idempotency or transactional deduplication — not exactly-once delivery.

**Exactly-once *processing* (the achievable version).** You can achieve
exactly-once *effects* by combining at-least-once delivery with one of: idempotent
operations (duplicates are no-ops), or a transactional dedup store that atomically
records "processed this message id" alongside the effect. Kafka's "exactly-once
semantics" is this: idempotent producers + transactional writes, not magic
exactly-once delivery. The honest framing in an interview: "exactly-once delivery
is not achievable; exactly-once processing is, via idempotency."

**The ack and its timing is the whole game.** Where you place the acknowledgment
relative to processing *is* what determines the semantics. Ack-before-process =
at-most-once. Ack-after-process = at-least-once. There's no ack placement that gives
exactly-once, because the ack itself can be lost in transit.

**Manual vs automatic ack.** Automatic ack (the broker considers a message
delivered as soon as it's sent) tends toward at-most-once and is dangerous for
important messages. Manual ack (the consumer explicitly acks after processing) is
required for at-least-once. Our RabbitMQ consumers use manual ack after the handler
succeeds; on handler failure they nack (see dead-letter queues).

**Message durability and broker persistence.** Delivery guarantees also depend on
the message surviving a *broker* crash, not just a consumer crash. Durable queues +
persistent messages (both set in our RabbitMQ config) ensure messages aren't lost
if the broker restarts. At-least-once requires this durability plus consumer acks.

**Prefetch and its effect.** The prefetch count controls how many unacked messages
a consumer can hold. `prefetch(1)` (what we use) means one-at-a-time: the broker
won't dispatch a new message until the current one is acked. This enables fair
dispatch across replicas and prevents a slow consumer from hoarding messages, at
some throughput cost.

### Practical worked example

At-least-once via manual ack after processing (from the RabbitMQ helper):

```typescript
await channel.consume(queue, async (msg) => {
  try {
    await handler(routingKey, JSON.parse(msg.content.toString()));
    channel.ack(msg);          // ACK ONLY AFTER success → at-least-once
  } catch (err) {
    channel.nack(msg, false, false);   // failure → dead-letter (don't loop)
  }
});
```

If the process crashes *after* `handler` succeeds but *before* `channel.ack`, the
broker never sees the ack and redelivers the message on reconnect — a duplicate,
made safe by the consumer's idempotency. That's the at-least-once contract in
action.

Durable + persistent so broker restarts don't lose messages:

```typescript
await channel.assertExchange(EXCHANGE, 'topic', { durable: true });     // survives restart
channel.publish(EXCHANGE, routingKey, body, { persistent: true });     // written to disk
```

### 10 senior interview questions

1. **Define at-most-once, at-least-once, and exactly-once. How do you achieve each
   (or why can't you)?** (Ack-before = at-most-once/lossy; ack-after =
   at-least-once/duplicating; exactly-once delivery is unachievable — exactly-once
   *processing* via idempotency/transactions.)

2. **Why is exactly-once delivery impossible in a distributed system?** (Lost acks
   over an unreliable network — the sender can't distinguish "processed, ack lost"
   from "not processed"; ties to the Two Generals problem.)

3. **What does Kafka mean by "exactly-once semantics," really?** (Idempotent
   producers + transactional writes = exactly-once *processing/effects*, not
   exactly-once delivery.)

4. **Where you place the ack determines the semantics — explain.** (Ack before
   processing risks loss on crash → at-most-once; ack after risks redelivery on
   crash → at-least-once; no placement yields exactly-once because the ack can be
   lost.)

5. **Your system uses at-least-once. What must consumers guarantee and why?**
   (Idempotency — duplicates are inevitable and must be harmless.)

6. **When is at-most-once the right choice? Give a concrete scenario.** (High-volume
   telemetry/metrics where occasional loss is fine and duplicates would skew
   aggregates; loss cheaper than dedup overhead.)

7. **Explain manual vs automatic ack and the risk of auto-ack for important
   messages.** (Auto-ack marks delivered on dispatch → loss on crash before
   processing; manual ack after processing is required for reliability.)

8. **Delivery guarantees depend on surviving broker crashes too. How do you ensure
   that?** (Durable queues + persistent messages so the broker persists to disk;
   otherwise a broker restart loses messages regardless of acks.)

9. **What does prefetch/QoS control, and what's the trade-off of prefetch=1?**
   (How many unacked messages a consumer holds; prefetch=1 gives fair dispatch and
   prevents hoarding at some throughput cost; higher prefetch boosts throughput but
   can unbalance load.)

10. **Design a payment consumer that must never double-charge under at-least-once
    delivery. Walk through the full approach.** (Idempotency key = order/charge id
    with a unique constraint; check-or-insert atomically; return prior result on
    duplicate; ack after the DB commit.)

11. **A message is redelivered repeatedly and keeps failing. Walk through what
    should happen.** (Retry with backoff up to a limit, then dead-letter for
    inspection; never loop forever; alert on DLQ growth.)

12. **How do delivery semantics interact with consumer scaling and ordering?**
    (Multiple consumers break strict ordering; if order matters, partition by key
    so each key's messages go to one consumer; at-least-once still applies per
    partition.)

---

## 9. Dead-Letter Queues

### The principle

A dead-letter queue (DLQ) is where messages go when they cannot be processed
successfully — after repeated failures, on rejection, or on expiry. Instead of
silently dropping a bad message or letting it loop forever (blocking the queue), the
broker routes it to a separate queue for inspection, alerting, and manual or
automated recovery. This platform routes rejected messages to a dead-letter
exchange feeding a dead-letter queue.

### The minute sub-concepts

**The "poison message" problem.** A poison message is one that a consumer can never
process successfully — malformed payload, a bug triggered by its specific data, or a
permanent downstream failure. Without a DLQ, two bad outcomes: if you requeue it, it
loops forever, blocking the queue and burning resources (a "poison pill" stalling
the consumer); if you drop it, you lose data silently with no record. The DLQ is the
third, correct option: set it aside safely.

**What triggers dead-lettering (in RabbitMQ).** A message is dead-lettered when: (a)
it's *rejected* or *nacked* with `requeue=false`; (b) it *expires* due to a
per-message or per-queue TTL; or (c) the queue *exceeds its length limit* and the
message is dropped from the head. You configure a queue with a `deadLetterExchange`;
dead-lettered messages are republished to that exchange, which routes them to the
DLQ.

**Dead-letter exchange (DLX) vs dead-letter queue (DLQ).** The DLX is an exchange
that dead-lettered messages are routed *to*; the DLQ is a queue *bound to* the DLX
that actually holds them. This indirection lets you route different failures to
different places, or fan a single DLX out to a DLQ plus an alerting consumer. Our
setup uses a fanout DLX bound to one DLQ.

**Retry vs dead-letter — the policy decision.** Not every failure should
immediately dead-letter. Transient failures (a brief downstream outage, a network
blip) deserve retries, ideally with exponential backoff. Permanent failures
(malformed data) should dead-letter immediately, since retrying is pointless. A
common pattern: a retry queue with a TTL that re-delivers after a delay, and a retry
counter in the message header; once retries are exhausted, route to the DLQ. Our
baseline dead-letters on handler failure; a production system layers retries in
front.

**Delayed-retry with TTL + DLX (the "retry queue" trick).** RabbitMQ has no native
delayed retry, but you build it: nack the message to a "wait" queue that has a TTL
and whose own dead-letter target is the original queue. The message sits for the
TTL, then is dead-lettered *back* to the main queue for another attempt. Chaining
these gives exponential backoff. This is a classic senior-level RabbitMQ pattern.

**What you do with dead-lettered messages.** The DLQ is not a graveyard — it's an
operational surface. You monitor its depth (a growing DLQ is an alert-worthy signal
something is broken), inspect messages to diagnose the failure, fix the root cause
(deploy a fix, correct the data), and then *replay* the messages back onto the main
queue. Good systems have tooling to inspect and replay DLQ contents.

**Poison-message detection and the redelivery count.** To avoid dead-lettering a
message that would actually succeed on retry, and to avoid infinite retries, you
track how many times a message has been delivered (via a header you increment, or
the `x-death` header RabbitMQ adds on each dead-lettering). After N attempts you
stop retrying and dead-letter permanently.

**Alerting is essential.** A DLQ that no one watches is as bad as dropping messages
— the data is preserved but the failure is invisible. DLQ depth should be a
monitored metric with an alert, so a spike in dead-letters pages someone. This ties
into the observability work in Phase 5.

### Practical worked example

The dead-letter topology (from the RabbitMQ helper): a fanout DLX feeding one DLQ,
and consumer queues configured to dead-letter to it:

```typescript
// Dead-letter exchange + queue, asserted at startup.
await channel.assertExchange(DLX, 'fanout', { durable: true });
await channel.assertQueue(DLQ, { durable: true });
await channel.bindQueue(DLQ, DLX, '');

// Each consumer queue is told to dead-letter rejected messages to the DLX.
await channel.assertQueue(queue, { durable: true, deadLetterExchange: DLX });
```

Dead-lettering on handler failure (nack with requeue=false so it doesn't loop):

```typescript
try {
  await handler(routingKey, payload);
  channel.ack(msg);
} catch (err) {
  // requeue:false → send to the DLX/DLQ instead of looping on the main queue.
  channel.nack(msg, false, false);
}
```

A conceptual delayed-retry queue (TTL + dead-letter back to the source) for
exponential backoff:

```
main.queue  --(nack)-->  retry.5s (TTL=5s, DLX→main.queue)  --(after 5s)-->  main.queue
            --(nack again)-->  retry.30s (TTL=30s, DLX→main.queue)  --> ...
            --(retries exhausted)-->  DLQ (inspect + replay)
```

You can observe dead-lettering by publishing a malformed event: the consumer's
handler throws, the message is nacked without requeue, and it appears in the DLQ
(visible in the RabbitMQ management UI at `http://localhost:15672`, guest/guest)
instead of stalling the main queue.

### 10 senior interview questions

1. **What is a dead-letter queue and what problem does it solve?** (A queue for
   messages that can't be processed; solves poison messages that would otherwise
   loop forever or be silently dropped.)

2. **Describe the poison-message problem and the two bad outcomes of not having a
   DLQ.** (Infinite requeue loop blocking the queue, or silent data loss; DLQ is
   the safe third option.)

3. **In RabbitMQ, what conditions cause a message to be dead-lettered?** (Reject/
   nack with requeue=false, message/queue TTL expiry, or queue length limit
   exceeded.)

4. **Distinguish a dead-letter exchange from a dead-letter queue.** (DLX is the
   exchange dead-lettered messages route to; DLQ is a queue bound to it that holds
   them; indirection enables flexible routing/fan-out.)

5. **When should a failure be retried vs. immediately dead-lettered?** (Transient
   failures → retry with backoff; permanent failures like malformed data →
   dead-letter immediately since retry is futile.)

6. **RabbitMQ has no native delayed retry. How do you build exponential backoff?**
   (TTL "wait" queues whose DLX targets the source queue; chain increasing TTLs;
   track a retry count and dead-letter permanently after N attempts.)

7. **How do you prevent infinite retries of a message that always fails?** (Track a
   redelivery/retry count via header or x-death; after a threshold route to the DLQ
   permanently.)

8. **What should operational tooling around a DLQ provide?** (Depth monitoring with
   alerts, message inspection, root-cause diagnosis, and replay back to the main
   queue after a fix.)

9. **Why is alerting on DLQ depth critical?** (An unwatched DLQ preserves data but
   hides the failure; a spike must page someone; ties into observability/SLOs.)

10. **Walk through the full lifecycle of a message that fails permanently, from
    first delivery to resolution.** (Deliver → handler fails → retry with backoff →
    retries exhausted → dead-letter to DLQ → alert fires → engineer inspects →
    fixes root cause → replays message → succeeds.)

11. **A DLQ is filling rapidly in production. Walk through your incident response.**
    (Check DLQ depth trend and sample messages; identify common failure; determine
    transient vs permanent; roll back/deploy fix; replay after fix; add a
    regression test.)

12. **How do dead-letter queues interact with idempotency and at-least-once
    delivery?** (Replayed DLQ messages are duplicates from the consumer's view;
    idempotent processing ensures replay is safe and doesn't double-apply effects.)

---

# Phase 4 — Concept Deep-Dives

Two concepts underpin the notification layer, each covered with mechanics,
worked examples, and senior-level interview Q&A:

10. Pub/Sub fan-out (exchanges, queues, and consumer groups)
11. Event-carried state transfer (and per-consumer idempotency strength)

---

## 10. Pub/Sub Fan-Out

### The principle

Fan-out means one published event is delivered to *multiple independent
consumers*, each processing it for its own purpose. In RabbitMQ the mechanism
is the exchange/queue split: publishers send to an **exchange** with a routing
key; the exchange copies the message into every **queue** whose binding
matches. The publisher neither knows nor cares how many queues are bound. In
this platform, `payment.succeeded` was already consumed by the Order service
(to advance the saga); Phase 4 binds a second queue — `notification.events` —
to the same exchange and the same routing keys, and the Notification service
starts receiving copies of the same events. Not one line of producer code
changed.

### The minute sub-concepts

**The exchange/queue split is the whole design.** A queue delivers each
message to exactly ONE of its consumers. An exchange copies each message to
EVERY bound queue. These compose into the two fundamental patterns:

- one queue, N consumers → **competing consumers** (work distribution: each
  message processed once, by whichever replica takes it)
- N queues, one exchange → **fan-out** (broadcast: each message processed once
  *per queue*)

A "consumer group" is therefore just "a queue": every service that needs its
own copy of the stream declares its own queue; every replica of that service
shares that queue.

**Scaling interacts with both at once.** Scale notification-service to 3
replicas and all 3 consume `notification.events` — competing consumers within
the group, so each event still produces exactly one notification. The saga
services are unaffected: their queues are separate. Fan-out across groups,
competition within a group.

**Topic exchange binding semantics.** Bindings are patterns over dot-separated
routing keys: `*` matches exactly one word, `#` matches zero or more.
`order.*` matches `order.created` but not `order.item.added`; `order.#`
matches both. This project binds explicit keys (`order.created`,
`payment.succeeded`, `payment.failed`, `inventory.rejected`) rather than
`#` — subscribing narrowly is deliberate: a consumer that takes everything
becomes coupled to every future event's existence.

**Producers must not know about consumers — verify it.** The test of true
decoupling is exactly what Phase 4 did: add a consumer with zero producer
changes. If adding a consumer requires touching the producer, you have
point-to-point messaging wearing a pub/sub costume.

**Each queue has independent depth, lag, and failure.** One slow consumer
group backs up ITS queue only; the saga queues keep draining. This isolation
is fan-out's operational superpower — and its trap: an abandoned bound queue
(consumer removed, binding left behind) accumulates messages forever. Monitor
per-queue depth (Phase 5).

**Durability is per-layer.** Durable exchange + durable queue + persistent
messages are three separate flags; a persistent message in a non-durable queue
still dies with the broker. This project sets all three for every saga-related
entity.

**Delivery to N queues is not a transaction.** The broker copies the message
to each bound queue individually; consumers see it at different times. Fan-out
consumers must not assume any ordering *between* groups — only per-queue
FIFO-ish ordering within one.

### Practical worked example

The entire Phase 4 "integration" is one `subscribe` call in the Notification
service:

```ts
await subscribe(
  'notification.events',                       // OUR queue (consumer group)
  ['order.created', 'payment.succeeded',
   'payment.failed', 'inventory.rejected'],    // bindings on the SAME exchange
  onEvent,
);
```

Compare with the Order service, which was already subscribed to some of the
same keys:

```ts
await subscribe('order.payment-succeeded', ['payment.succeeded'], ...);
```

Same exchange (`ecommerce.events`), same routing key (`payment.succeeded`),
two different queues → RabbitMQ copies each `payment.succeeded` into both.
Prove it live:

```powershell
docker compose ... exec rabbitmq rabbitmqctl list_bindings source_name destination_name routing_key
```

You'll see `ecommerce.events → order.payment-succeeded (payment.succeeded)`
AND `ecommerce.events → notification.events (payment.succeeded)`. Place a
`BOOK-001` order and both consumers log their own handling of the same event:
the Order service flips the order to CONFIRMED; the Notification service
"sends" *Your order is confirmed*.

### 10 senior interview questions

1. **A message must be processed by every service that cares, but only once
   per service, even when services are scaled. Design the topology.** (One
   exchange; one durable queue per service/consumer-group bound to relevant
   keys; replicas of a service share its queue — fan-out across queues,
   competing consumers within one.)
2. **What's the difference between a RabbitMQ fanout exchange and achieving
   fan-out with a topic exchange?** (A fanout exchange ignores routing keys
   and copies to all bound queues; a topic exchange fans out only to queues
   whose patterns match — selective fan-out. This project uses topic so each
   group subscribes narrowly; the DLX here is a true fanout exchange.)
3. **How does RabbitMQ's model compare to Kafka's for fan-out?** (Kafka:
   consumers pull from a shared log; each consumer group tracks its own
   offset; fan-out is free and replayable. RabbitMQ: broker pushes copies
   into per-group queues; no replay after ack. Kafka suits event streaming/
   reprocessing; RabbitMQ suits task/command distribution and complex
   routing.)
4. **What happens if a bound queue has no consumer for a week?** (It
   accumulates all matching messages — unbounded growth, broker memory/disk
   pressure. Mitigate: monitor queue depth, set max-length or TTL policies,
   and delete bindings when retiring consumers.)
5. **New consumer group added today — can it see yesterday's events?** (No.
   Queues only receive messages published after the binding exists. If
   replay matters, you need an event store/log — Kafka, or an outbox table
   you can re-drain — and this trade-off should be named at design time.)
6. **Does adding consumer groups slow producers down?** (Publishing cost
   grows slightly with copies, but producers don't wait for consumers;
   confirm mode waits only for broker persistence. The real risk is broker
   resource pressure from many/slow queues, not producer latency.)
7. **How do you prevent a 'catch-all' consumer becoming a coupling point?**
   (Bind explicit keys rather than `#`; treat event schemas as published
   contracts; version events additively — new fields, not changed meanings —
   so old consumers keep working.)
8. **Where does ordering break in fan-out systems?** (Order is per-queue at
   best; redelivery and multiple replicas reorder within a group; between
   groups there is no ordering at all. Consumers must rely on state
   machines/versions, not arrival order — the saga's persisted status does
   exactly this.)
9. **One consumer group needs the event 99.999% reliably; another is
   best-effort. Same exchange?** (Yes — reliability is per-queue: the
   critical group gets durable queue + persistent messages + DLX + monitoring;
   the best-effort group can use TTL/max-length. Fan-out lets consumers choose
   their own guarantees.)
10. **How would you test that your system is genuinely pub/sub decoupled?**
    (Add a new consumer group in a sprint with zero producer diffs — Phase 4
    is literally this test. Also: kill a consumer group and verify producers
    and sibling groups are unaffected.)

---

## 11. Event-Carried State Transfer

### The principle

Consumers of events often need more context than the triggering event carries.
`payment.failed` says *which order* failed — but a notification needs *which
user* to tell. There are three ways to get it: call the owning service back
(synchronous coupling returns through the back door), share the database
(worst option — breaks ownership), or **carry the state in the events
themselves** and let each consumer accumulate the slice it needs. Phase 4 does
the third: `order.created` now carries `userId`, and the Notification service
remembers `orderId → user` locally, so when `payment.failed` arrives later it
can attribute the notification without asking anyone.

### The minute sub-concepts

**Thin vs fat events.** A thin event is a notification-with-an-ID ("order
1234 changed — come ask me"); a fat event carries the state ("order 1234,
user 42, items [...] was created"). Thin keeps payloads small but forces
consumers to call back (re-coupling, and a read-your-own-write race: the
callback may hit a replica that hasn't seen the write). Fat decouples fully
but bloats the bus and can smear ownership. The engineering answer is
*deliberately sized* events: carry what downstream consumers legitimately
need — here, `userId` — not the whole aggregate.

**Additive schema evolution.** Adding `userId` to `order.created` broke
nothing: the Inventory service destructures `{ orderId, items }` and ignores
extra fields. That's the contract discipline for event payloads: add fields
freely; never rename, remove, or change the meaning of existing ones without
a versioning strategy (new event type or explicit version field).

**Consumer-local state is a cache built from the stream.** The Notification
service's `orderId → user` map is not a second source of truth — it's a
projection, rebuildable (in principle) by replaying events, and safe to lose
in proportion to what it powers. This is the same idea that scales up to CQRS
read models; here it's a bounded in-memory map because notifications tolerate
that.

**Bound your projections.** In-memory maps grow forever unless capped. This
service caps at 1000 entries with insertion-order eviction (a Map iterates in
insertion order — a poor man's LRU). Naming the bound, and what happens past
it (a very old order's late event would notify `user:unknown`), is the senior
move; unbounded caches are memory leaks with better PR.

**Idempotency strength is a per-consumer decision.** At-least-once delivery
threatens every consumer with duplicates, but the correct defense differs by
stakes. Inventory mutates money-adjacent state → durable `processed_
reservations` table inside the same DB transaction. Notification sends an
email → a bounded in-memory `(event, orderId)` dedupe set suffices; the worst
post-restart failure is one repeated email. Matching the mechanism to the
blast radius — rather than maximal machinery everywhere — is the skill
interviewers probe.

**Loss semantics of a stateless consumer.** Restart the Notification service
and both its maps vanish. Consequences: a duplicate email is possible (dedupe
set lost), and events for pre-restart orders attribute to `user:unknown`
(context map lost). Both are acceptable *for this consumer* and would be
unacceptable for inventory. Same events, different consumers, different
durability — by design, and the design is defensible out loud.

### Practical worked example

The producer side is one enriched payload in the Order service's outbox
insert:

```ts
JSON.stringify({ orderId, userId: input.userId, items: input.items })
```

The consumer side learns, then uses, the context:

```ts
if (routingKey === 'order.created') {
  remember(orderContext, evt.orderId, { userId: evt.userId, items: evt.items ?? [] });
}
// ... later, for payment.failed on the same order:
const ctx = orderContext.get(orderId);
const to = ctx?.userId ? `user:${ctx.userId}` : 'user:unknown';
```

Run the FAILED demo (`LAPTOP-001 x1`) and check
`curl.exe -s http://localhost:3006/notifications`: the *Payment failed* entry
is attributed to your real user id, even though `payment.failed` itself never
carried it — the state traveled in `order.created` and was joined locally.

### 10 senior interview questions

1. **A downstream consumer needs data the triggering event doesn't carry.
   Enumerate your options and their costs.** (Call back to the owner —
   synchronous coupling + read-after-write races; shared DB — breaks
   ownership, schema coupling; carry state in events — decoupled, but
   payload growth + eventual consistency of the consumer's copy.)
2. **Thin vs fat events — when is each right?** (Thin when consumers are few/
   internal and freshness matters more than autonomy; fat when consumer
   autonomy, audit, or fan-out breadth matters. Middle path: carry the fields
   downstream demonstrably needs.)
3. **How do you evolve an event schema without breaking consumers?**
   (Additive-only changes; consumers ignore unknown fields; never repurpose a
   field; breaking changes get a new event name/version and a migration
   window where both are published.)
4. **Is the notification service's orderId→user map a source of truth?**
   (No — a projection/cache derived from the stream. The order DB remains the
   truth; the map is rebuildable and safe to lose in proportion to its use.)
5. **What are the failure modes of consumer-local state, and how do you
   bound them?** (Staleness — a later user-email change isn't reflected;
   loss on restart — attribute-unknown fallbacks; unbounded growth — cap +
   eviction. State the fallback behavior explicitly.)
6. **Why did inventory get a durable processed-events table while
   notification got an in-memory set? Defend the asymmetry.** (Idempotency
   strength should match the cost of a duplicate: double-reserved stock is a
   data corruption; a duplicate email is an annoyance. Durable dedupe costs a
   DB round-trip per event — pay it where duplicates are expensive.)
7. **A duplicate `payment.failed` arrives after a restart wiped the dedupe
   set. Walk through what happens.** (Set lookup misses → notification sent
   again → one repeated email. Order state is untouched — the saga's own
   idempotency lives in the orchestrator/DB, not here. Acceptable by stated
   design.)
8. **When does consumer-local projection graduate into CQRS?** (When the
   projection needs durability, its own query API, rebuild/replay tooling, or
   serves user-facing reads. Same concept, industrialized: events →
   materialized read model in its own store.)
9. **How would you replay/rebuild a consumer's state in this RabbitMQ-based
   system, given queues don't retain acked messages?** (You can't from the
   broker — you'd re-drain from a durable source: the outbox table, an event
   store, or switch the backbone to a log like Kafka. Knowing the broker's
   retention model drives this answer.)
10. **Carrying `userId` in `order.created` duplicates data the order DB
    owns. Is that a smell?** (No — events are immutable facts, snapshots at
    a point in time, not live references. Duplication into events is how
    autonomy is bought; the smell would be consumers *writing* that data back
    somewhere authoritative.)

---

# Phase 5 — Concept Deep-Dives

Three concepts — the "three pillars" — each covered with mechanics, worked
examples, and senior-level interview Q&A:

12. Metrics with Prometheus (pull model, histograms, RED, cardinality)
13. Centralized structured logging with Loki (the label-index bet)
14. Distributed tracing with OpenTelemetry (context propagation, sampling)

---

## 12. Metrics with Prometheus

### The principle

A metric is a pre-aggregated number about your system, cheap enough to record
on every event and to keep at high resolution: request counts, durations,
queue depths, orders confirmed. Prometheus's model has two defining choices:
it **pulls** (services expose a `/metrics` endpoint; Prometheus scrapes on its
schedule), and it stores **labeled time series** (`http_request_duration_
seconds_count{service="order-service", route="/orders", status_code="202"}`).
Every service in this platform now exposes real prom-client metrics; Traefik
and RabbitMQ expose their built-ins; Prometheus scrapes all of it every 10s.

### The minute sub-concepts

**Pull vs push.** Pull means the monitoring system decides the schedule,
target discovery is explicit (you can SEE what should exist), and a down
target is *detectable* (`up == 0`) rather than silently absent. Push
(StatsD/OTLP-push) suits short-lived jobs and serverless, where nothing lives
long enough to be scraped. Pull also fails safe: a slow Prometheus degrades
resolution, not the services.

**The four metric types.** *Counter* — monotonically increasing (requests,
orders); only ever read through `rate()`. *Gauge* — goes up and down (queue
depth, heap). *Histogram* — counts observations into cumulative buckets;
enables percentile *estimation* server-side and aggregation across instances.
*Summary* — client-side exact quantiles, but un-aggregatable across replicas;
histograms won for a reason.

**Histograms and `histogram_quantile`.** Our latency histogram has buckets
5ms…5s. `histogram_quantile(0.95, sum by (le, service)(rate(..._bucket[5m])))`
estimates p95 by linear interpolation *within* the bucket the quantile falls
into — accuracy is bucket-resolution-bound. Two consequences seniors know:
choose buckets around your SLO (a 250ms SLO wants buckets at 200/250/300, so
violations are crisp), and NEVER average percentiles across services — you
aggregate the underlying buckets, which is exactly what histograms make
possible.

**Cardinality is the whole game.** Every unique label combination is a
separate stored time series. `route` is safe only because we record the route
*template* (`/orders/:id`, via Fastify's `routeOptions.url`) — recording raw
URLs would mint a series per order UUID and melt the TSDB. The platform's
label sets are bounded by construction: `status` ∈ {CONFIRMED, FAILED,
REJECTED}, `outcome` ∈ {succeeded, failed} etc. Rule: labels must come from
small, closed sets — never user IDs, order IDs, emails.

**RED and USE.** For request-driven services: **R**ate, **E**rrors,
**D**uration — our histogram gives all three (count-rate, status_code≥500
rate, quantiles). For resources: **U**tilisation, **S**aturation, **E**rrors —
that's the RabbitMQ and Node-runtime metrics (queue depth is saturation of
the async path). Instrument RED at every service boundary, USE at every
resource, and dashboards design themselves.

**Default labels beat scrape labels.** Each registry sets `service` as a
default label in-process, so series are correctly attributed even if someone
scrapes the endpoint ad hoc; the scrape config only labels infra targets that
can't label themselves (Traefik, RabbitMQ).

**What metrics can't do.** They're aggregates — they tell you p95 degraded,
never *which request* or *why*. That's the hand-off to traces (exemplars
formalize it) and logs. Knowing which pillar answers which question is the
observability skill.

### Practical worked example

The instrumentation is ~15 lines per service. The histogram observation hook:

```ts
app.addHook('onResponse', async (req, reply) => {
  const route = req.routeOptions?.url ?? req.url;   // template, not raw URL!
  if (route === '/metrics' || route.startsWith('/health')) return;
  httpRequestDuration
    .labels(req.method, route, String(reply.statusCode))
    .observe(reply.elapsedTime / 1000);
});
```

And a domain counter at a business-meaningful transition (order saga):

```ts
await setStatus(evt.orderId, 'CONFIRMED');
ordersTerminalTotal.labels('CONFIRMED').inc();
```

Run the three demo orders, then in Prometheus (http://localhost:9090) query
`sum by (status) (orders_terminal_total)` — you get the saga funnel as data:
1 CONFIRMED, 1 FAILED, 1 REJECTED. Then
`histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))`
shows per-service p95 — the exact query behind the Grafana panel.

### 10 senior interview questions

1. **Prometheus pulls; StatsD pushes. Argue both sides and pick for a
   long-running microservice fleet.** (Pull: explicit target inventory,
   up-detection, monitoring controls load; push: works for short-lived jobs,
   NAT-friendly. Fleet of long-running services → pull; add Pushgateway only
   for batch jobs, sparingly.)
2. **Why can't you average p95s from two replicas, and what does a histogram
   change?** (Percentiles aren't linear — avg(p95a, p95b) is meaningless.
   Histograms ship the raw bucket counts, which ARE summable; you compute the
   quantile AFTER aggregating buckets.)
3. **A teammate adds `user_id` as a metric label. What happens and what do
   you do instead?** (Cardinality explosion — one series per user, memory/
   ingest blowup. Move per-user questions to logs/traces; keep labels from
   closed sets.)
4. **Design the bucket boundaries for a 300ms-SLO endpoint.** (Cluster
   buckets around the SLO — e.g. 100/200/250/300/400/500ms/1s — so the
   SLO-violation boundary is a bucket edge and error budgets are exact, not
   interpolated.)
5. **What's the difference between `rate()` and `irate()`, and when does
   each mislead?** (rate = per-second average over the window — smooth,
   good for alerting; irate = last two samples — spiky, good for fast
   dashboards, terrible for alerts. Both need the window ≥ 2 scrape
   intervals.)
6. **How do counters survive process restarts?** (They don't — they reset to
   0. `rate()` detects monotonicity breaks and compensates, which is exactly
   why you never graph raw counters, only rates/increases.)
7. **RED vs USE — instrument a message consumer.** (It has no HTTP requests:
   RED maps to events consumed/sec, handler failures, handler duration; USE
   adds queue depth (saturation), prefetch utilisation, redelivery rate.)
8. **When metrics show p95 latency doubled, what CAN'T they tell you, and
   what's your next hop?** (Not which requests, not why — aggregates lose
   the individual. Next hop: exemplars/traces filtered to the slow window,
   then logs for the guilty trace IDs.)
9. **Scrape interval is 10s. What alerting mistake does that constrain?**
   (Any `rate()` window must be several× the interval, alerts can't detect
   sub-10s spikes, and `for:` durations shorter than a couple of scrapes
   flap. Resolution bounds everything downstream.)
10. **The gateway histogram and Traefik's metrics disagree on request
    counts. Name three legitimate reasons.** (Traefik counts edge requests
    incl. redirects/TLS failures the gateway never sees; health checks
    excluded in one, not the other; retries/replays counted per-hop; and
    scrape phase differences within the window.)

---

## 13. Centralized Structured Logging with Loki

### The principle

Logs answer "what exactly happened," and in a 16-container system reading
per-container logs stops scaling immediately. Centralized logging ships every
container's stdout to one queryable store. Loki's defining bet: **index only
labels** (service, level), not log content. Content is stored compressed and
grep'd at query time *within* the label-selected streams. This platform was
accidentally ready for it: every service already logs single-line pino JSON —
Promtail discovers containers over the Docker socket, parses the JSON, labels
the stream, and pushes to Loki.

### The minute sub-concepts

**Structured logging is the precondition.** `logger.info({ orderId, status },
'order updated')` emits one JSON line with machine-parseable fields. The
alternative — string interpolation — makes every downstream query a regex
archaeology dig. The discipline was established in Phase 1; Phase 5 is where
it pays.

**Loki's label model vs full-text indexing.** Elasticsearch indexes every
token of every line — queries on anything are fast, but the index often
exceeds the data, and ingest is expensive. Loki indexes only the small label
set; storage is cheap chunks; queries pay at read time. The trade is
economics: logs are write-heavy/read-rarely, so indexing everything optimizes
the rare path. The corollary discipline is identical to Prometheus:
**labels must be low-cardinality** (service, level — never orderId; orderId
lives in the JSON body and is filtered at query time).

**LogQL mirrors PromQL deliberately.** `{service="order-service"} | json |
orderId="..."` — select streams by label, then pipeline-parse and filter.
Because label keys match the metrics labels (`service`), Grafana can pivot
from a latency panel to that service's logs in one click — that shared label
scheme IS the integration, and it was a choice, not luck.

**Collection topology.** One Promtail per host (here: one container) reading
all container logs beats a logging library in every app: apps stay decoupled
from the log pipeline, crashes can't lose buffered logs inside the app, and
stdout remains the 12-factor contract. Promtail's `docker_sd_configs`
discovers containers and reads logs via the Docker API — the relabel step
maps `com.docker.compose.service` → `service`.

**Levels as pino numbers.** pino emits `level` numerically (30=info, 40=warn,
50=error) — bounded cardinality, so it's safe as a label; the runbook notes
the mapping. Filtering errors platform-wide: `{level="50"}`.

**Retention and loss-tolerance.** Logs are the most voluminous pillar; local
config keeps filesystem chunks with no replication (`replication_factor: 1`)
— fine for a laptop, and the exact knob you'd point at when asked "what
changes in prod?" (object storage, retention/compactor, replication).

### Practical worked example

The entire app-side change for Phase 5 logging is: nothing. The pipeline is
config:

```yaml
scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
    relabel_configs:
      - source_labels: ['__meta_docker_container_label_com_docker_compose_service']
        target_label: 'service'
    pipeline_stages:
      - json: { expressions: { level: level, msg: msg } }
      - labels: { level: }
```

Place a FAILED order, then in Grafana → Explore → Loki:

```
{service=~"order-service|inventory-service"} | json | msg=~".*compensation.*"
```

Both halves of the compensation appear — the orchestrator enqueueing the
release and inventory executing it — interleaved with timestamps, across two
containers, from one query. That's the capability per-container `docker logs`
can never give you.

### 10 senior interview questions

1. **Loki vs Elasticsearch for logs — argue the trade.** (ES: full-text
   index, fast arbitrary search, heavy ingest/storage; Loki: label-only
   index, cheap ingest/storage, query-time grep. Logs are write-heavy and
   read-rarely → Loki's bet usually wins on cost; ES wins for search-heavy
   use like security forensics.)
2. **What belongs in a Loki label vs the log body, and why?** (Labels:
   low-cardinality stream identity — service, level, env. Body: everything
   per-event — orderId, userId, durations. High-cardinality labels shatter
   streams into millions of tiny chunks and destroy both ingest and query.)
3. **Why collect via a node agent reading stdout instead of an in-app
   shipper library?** (Decouples app from pipeline, survives app crashes,
   zero app dependencies/config, uniform across languages, honors the
   12-factor stdout contract; in-app shippers buffer in the failure domain
   they're reporting on.)
4. **Your logs are multi-line stack traces and they arrive as N separate
   entries. What broke and how do you fix it?** (Line-based collection
   splits them; fix at source — single-line JSON with the stack in a field,
   as pino does — or configure multiline stages, which are fragile.
   Structured logging at source is the real fix.)
5. **How do you correlate a log line to the request that caused it across
   services?** (Propagated correlation/trace ID stamped into every log line
   — with OTel active, inject traceId into the pino mixin; then LogQL filter
   `| json | traceId="..."` reconstructs the request story, and Grafana
   links logs ↔ traces.)
6. **A teammate logs at info inside the per-message consumer hot path.
   Costs?** (Log volume scales with throughput — ingest cost, noise burying
   signal, and possible event-loop pressure. Hot paths get debug-level or
   sampled logging; info marks state transitions.)
7. **Design log retention for this platform in prod.** (Tiered: 24-72h hot
   in Loki for ops, 30-90d in object storage for audit/debug, compliance
   streams longer per policy; compactor + retention rules per tenant/stream;
   never 'keep everything hot forever'.)
8. **`docker logs` already exists. What specifically does centralization
   add?** (Cross-container queries in one place, retention beyond container
   lifecycle — logs survive `compose down` —, label-based filtering,
   correlation with metrics/traces in Grafana, and access without Docker
   host access.)
9. **When is grep-at-query-time (Loki) unacceptably slow, and what's the
   escape hatch?** (Needle-in-haystack over huge windows with weak label
   selectors; mitigations: better labels, structured filters early in the
   pipeline (`| json | field=...` prunes fast), recording the hot query as a
   metric, or promoting that use-case to a real index.)
10. **Why must the logging `service` label equal the metrics `service`
    label?** (Cross-pillar pivoting: Grafana panel → Explore carries the
    label; alerts link to logs pre-filtered. Divergent naming breaks every
    correlated workflow — the label scheme is an API between pillars.)

---

## 14. Distributed Tracing with OpenTelemetry

### The principle

One checkout touches the gateway, the order service, Postgres, RabbitMQ,
inventory, and payment. Metrics aggregate it away; logs shatter it across
containers. A **trace** reconstructs the single request: a tree of **spans**
(each a timed operation with attributes), stitched across process boundaries
by **context propagation** — a trace ID that travels inside HTTP headers and,
crucially here, inside RabbitMQ message headers. Phase 5 wires this with
ZERO application code: OpenTelemetry's Node auto-instrumentation is loaded
via `NODE_OPTIONS=--import`, patches the libraries we already use (fastify,
pg, ioredis, mongodb, amqplib, http), and exports OTLP to Jaeger.

### The minute sub-concepts

**Span mechanics.** A span = operation name, start/end timestamps, parent
span ID, trace ID, attributes (db.statement, messaging.destination…), status.
The tree of parent-child edges IS the causal structure; Jaeger's waterfall is
just that tree on a timeline. Gaps between a parent and its children are
un-instrumented time — often the actual bug.

**Context propagation is the hard part — and W3C `traceparent` is the
answer.** In-process, context rides AsyncLocalStorage; across HTTP, the
`traceparent: 00-<traceId>-<spanId>-01` header; across the broker, the SAME
header injected into AMQP message properties by the amqplib instrumentation
and extracted by the consumer. That last hop is what makes this platform's
demo special: the trace does not end at the 202 — it continues THROUGH
RabbitMQ into inventory and payment. Async hops appear with producer-consumer
**links/follows-from** semantics rather than strict parent-child timing.

**Auto vs manual instrumentation.** Auto-instrumentation (library patching
at load time) yields the skeleton — every HTTP call, query, publish, consume
— for zero code. Manual spans add business semantics (`span: reserve-stock`,
attribute `order.id`). The pragmatic sequencing is exactly what this phase
does: auto first, everywhere; manual only where questions remain. The
`--import` register trick works because Node loads the hook before the app,
so `require`/`import` of instrumented libraries returns patched versions.

**Sampling.** Tracing everything is expensive at scale. *Head sampling*
decides at trace start (cheap, uniform — the default `parentbased_always_on`
here, correct for a demo); *tail sampling* decides after completion (keep
all errors and slow traces, drop boring ones — needs a collector buffering
whole traces). The senior answer to "do you trace 100%?" is "locally yes; in
prod, head-sample a few % plus tail-keep errors/outliers."

**The exporter must fail soft.** Services do not `depends_on` Jaeger; the
OTLP exporter buffers, retries, and drops. Telemetry that can take down the
system it observes is a design failure — this is also why OTEL_* env only
arrives via the observability compose layer: remove the layer, and the SDK
is never even loaded.

**Traces complete the pillar triangle.** Metrics say WHAT degraded (p95 up),
traces say WHERE (the span that stretched), logs say WHY (the error detail,
found via the traceId). Each pillar's weakness is another's strength; the
shared keys (service label, trace ID) are the joints.

### Practical worked example

The "code" is one line of env in docker-compose.observability.yml:

```yaml
NODE_OPTIONS: "--import @opentelemetry/auto-instrumentations-node/register"
OTEL_SERVICE_NAME: "order-service"
OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
```

Place a CONFIRMED order, open Jaeger (http://localhost:16686), select
`order-service`, find the trace. The waterfall reads like the saga's
biography: gateway proxy span → order-service POST /orders → pg INSERT
(order + outbox, same span cluster) → amqplib publish `order.created` →
**inventory-service consume** (context crossed the broker!) → pg UPDATE
reserve → publish `inventory.reserved` → order consume → publish
`payment.requested`-side spans → payment consume → publish
`payment.succeeded` → order consume → pg UPDATE CONFIRMED. One trace ID,
five processes, both hops through RabbitMQ visible as producer→consumer
edges. This single screenshot is the most persuasive artifact in the whole
project.

### 10 senior interview questions

1. **Walk through how a trace ID crosses an async message broker.** (Producer
   instrumentation injects `traceparent` into message headers at publish;
   consumer instrumentation extracts it before the handler runs and starts a
   span linked to the producer context — parent/link semantics, surviving
   arbitrary queue delay.)
2. **Auto-instrumentation vs manual — when is each wrong?** (Auto-only:
   spans lack business meaning, noisy, misses in-process logic. Manual-only:
   enormous toil, inconsistent coverage, misses library internals. Auto for
   skeleton + targeted manual spans/attributes is the working answer.)
3. **What is `traceparent` and why did W3C standardization matter?**
   (`version-traceId-parentSpanId-flags`; before it, B3/vendor headers
   fragmented propagation across mixed fleets — standardization made
   cross-vendor, cross-team propagation interoperable by default.)
4. **Head vs tail sampling — design for 'keep all errors, 1% of the
   rest'.** (That policy is tail sampling by definition: a collector buffers
   spans until trace completion, applies policy; costs memory + a completion
   heuristic/timeout. Head sampling alone cannot see the error before
   deciding.)
5. **Your trace shows a 900ms gap between two spans with nothing in
   between. Interpret it.** (Un-instrumented work: event-loop blockage, GC,
   queue wait before consume, connection-pool wait, or sync CPU. The gap's
   parent tells you which process to profile; often the answer is 'time in
   the queue' — check the broker consume timestamp.)
6. **Why must telemetry export never be on the request path, and how does
   OTel ensure it?** (BatchSpanProcessor: spans buffered and exported
   async; bounded queues drop under pressure; exporter failures retry with
   backoff and then drop. Observability must degrade before it degrades the
   system.)
7. **How do traces, metrics, and logs reference each other in practice?**
   (Exemplars attach trace IDs to histogram buckets; logs carry traceId via
   logger integration; shared service naming. Workflow: alert (metric) →
   exemplar trace → trace's logs.)
8. **What's the overhead of tracing and where does it bite first?**
   (Per-span allocation + context propagation on every async boundary;
   hot-path services with many tiny spans suffer first; mitigations:
   sampling, span reduction, disabling noisy instrumentations — we disabled
   fs/dns-level noise via OTEL_NODE_ENABLED_INSTRUMENTATIONS.)
9. **A junior asks why the checkout trace's consumer spans aren't strict
   children of the publish span. Explain.** (The consume may happen long
   after publish — strict parent-child timing would imply the producer
   'contains' it. OTel models async hand-off as a link/follows-from: causal,
   not temporal containment.)
10. **You get one afternoon to add tracing to a 30-service Node fleet.
    Plan it.** (Exactly Phase 5's play: OTLP endpoint + collector/Jaeger;
    roll out env-based auto-instrumentation (`--import` register) via the
    deploy layer — no code changes; verify propagation across one async hop;
    THEN iterate manual spans on the top user journeys. Instrumentation via
    configuration is the force multiplier.)

---

# Phase 6 — Concept Deep-Dives

Three concepts underpin the delivery layer, each covered with mechanics,
worked examples, and senior-level interview Q&A:

15. CI/CD pipeline design for containerized microservices
16. Container supply-chain security
17. Dev/prod parity and configuration layering

---

## 15. CI/CD Pipeline Design for Containerized Microservices

### The principle

A CI/CD pipeline is the automated judgment about whether a change is safe to
ship, ordered so that cheap checks fail fast and expensive checks run only on
survivors. This platform's pipeline has five stages: Dockerfile lint and
per-service type-check/build run first (seconds, parallel matrix ×8); real
image builds gated by a CVE scanner run next; then the ENTIRE 16-container
platform boots inside the CI runner and the checkout saga is driven through
all three terminal paths; only when everything is green — and only on main —
are images pushed to the registry, tagged with the immutable commit SHA.

### The minute sub-concepts

**The testing-pyramid shape applied to pipelines.** Cost ordering is the
design: hadolint + `tsc` (~1 min, catches most breakage) → image build + scan
(~minutes) → full-stack smoke (~5-10 min) → push. Inverting the order wastes
runner-minutes re-discovering typos with a 10-minute integration boot.
`fail-fast: false` on the matrix is deliberate too: when three services break
at once you want to see all three, not re-run per fix.

**Matrix builds and change scoping.** One job template fans out over 8
services — identical steps, isolated failures, per-service npm caches keyed
on each lockfile. The next optimization (worth naming, deliberately not done
here) is path-filtering: only rebuild services whose files changed. Its cost
is drift risk — a shared-pattern change that doesn't touch a service's path
still might break it — which is exactly why the full compose-smoke stays
unconditional.

**`npm ci` vs `npm install` is a correctness issue, not style.** `install`
resolves ranges at run time — two builds a week apart can differ. `ci`
installs the lockfile exactly, deletes node_modules first, and fails if
lockfile and manifest disagree. Phase 6 generated lockfiles for all 8
services precisely so the Dockerfiles' `npm ci || npm install` stops silently
falling through to the unreproducible branch. Same input → same output is the
foundation the SHA-tagged image claim rests on.

**The compose-smoke stage is the senior differentiator.** Unit tests cannot
see broken compose wiring, a bad healthcheck, a queue binding typo, or a
migration that fails on a fresh database. Booting the real topology in CI —
same compose files as dev, fresh volumes every run — catches the class of
bug that otherwise ships. The smoke asserts BEHAVIOR: three saga outcomes,
stock restored by compensation, notifications fanned out. Cold-boot in CI
also continuously proves the "clone → up → works" claim a portfolio makes.

**CD semantics: what gets promoted is the artifact, not the source.** Images
are pushed tagged `:SHA` (immutable — what you tested is bit-for-bit what
you'd deploy) plus `:latest` (mutable convenience pointer). Real environments
promote the SHA through dev→staging→prod; re-building per environment breaks
the whole chain of custody. `push` is gated on `main` + both heavy stages
green, and the job holds the only elevated permission (`packages: write`) —
least privilege at the job level.

**Concurrency and hygiene.** `concurrency.cancel-in-progress` kills obsolete
runs when you push again — runner minutes are a budget. Timeouts on every
job prevent a hung container from burning an hour. Logs are dumped on smoke
failure and `down -v` runs `always()` — a failed run must not poison the next.

### Practical worked example

The gate ordering, from `.github/workflows/ci.yml`:

```yaml
image-build-scan:
  needs: [build-test, hadolint]     # cheap gates first
push-images:
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  needs: [image-build-scan, compose-smoke]   # ship only survivors
```

And the smoke's behavioral assertions (scripts/smoke-ci.sh) — the same three
paths every phase has verified locally, now enforced on every commit:

```bash
[ "$SA" = "CONFIRMED" ] || fail "expected CONFIRMED, got $SA"
[ "$SB" = "FAILED" ]    || fail "expected FAILED, got $SB"
[ "$SC" = "REJECTED" ]  || fail "expected REJECTED, got $SC"
AVAIL=$(curl -s http://localhost:3005/stock | jq -r '...LAPTOP-001...available')
[ "$AVAIL" = "2" ] || fail "compensation did not restore stock"
```

Push a commit that breaks the outbox relay and no unit test fires — but
CONFIRMED times out in wait_status and the pipeline blocks the merge. That
story, told with this file open, is the interview.

### 10 senior interview questions

1. **Order these stages and justify: image scan, unit tests, full-stack
   smoke, lint, registry push.** (Lint → unit/build → image build+scan →
   smoke → push: strictly increasing cost, decreasing frequency of failure;
   push last and branch-gated because artifacts are forever.)
2. **`npm install` passed CI for months; why mandate `npm ci` + lockfile?**
   (install re-resolves ranges — builds drift with upstream releases; ci is
   lockfile-exact, clean-room, and fails on manifest/lockfile mismatch —
   reproducibility is the precondition for 'tested = deployed'.)
3. **Monorepo of 8 services: when do you introduce path-filtered builds,
   and what must you keep unconditional?** (When matrix time hurts; filter
   the per-service build/test, but keep an integration gate unconditional —
   cross-cutting changes break services whose paths didn't change.)
4. **Why tag images with the commit SHA rather than a version or just
   latest?** (Immutability and provenance: SHA ties artifact to exact
   source + pipeline run; latest is a moving pointer that makes rollback
   and audit guesswork. Promote SHAs; never rebuild per environment.)
5. **What class of defect does booting the whole compose stack in CI catch
   that unit tests can't? Give three concrete examples from a system like
   this.** (Healthcheck/depends_on ordering bugs; queue binding/routing-key
   typos breaking the saga; migrations failing on fresh volumes; network
   segmentation mistakes — all invisible to in-process tests.)
6. **Your smoke stage is flaky at ~5%. Walk through your triage.**
   (Classify failures: fixed sleeps → replace with polling (our wait loop);
   port collisions → ephemeral/project-scoped resources; genuine races →
   they're real bugs, not test noise; quarantine-with-ticket beats retry-
   until-green, which institutionalizes rot.)
7. **Where do secrets live in CI and what never appears in a workflow
   file?** (Platform secret store injected as env/OIDC at run time; never
   literals in YAML or image layers; prefer short-lived OIDC federation to
   long-lived PATs; GITHUB_TOKEN scoped per-job — our push job alone gets
   packages:write.)
8. **Define CI vs CD vs continuous deployment for this project.** (CI:
   merge-gated build+verify — implemented; CD: every green main produces a
   deployable, promoted artifact — the GHCR push; continuous deployment:
   auto-release to prod, deliberately absent — the next rung would be
   environment promotion with approvals.)
9. **The pipeline is green but prod breaks on deploy. List the top gaps a
   compose-smoke leaves.** (Config drift between CI env and prod env (parity
   — see #17); data-shape differences (empty vs real volumes); scale effects
   (1 replica in CI); external dependencies stubbed locally; secrets/IAM
   differences.)
10. **How would you extend this pipeline for deploy, with rollback?**
    (Environment jobs consuming the SHA tag, protected by GitHub
    environments/approvals; health-gated rollout (compose pull + up, or
    graduate to k8s rolling update); rollback = repoint to previous SHA —
    possible ONLY because artifacts are immutable and promoted, not
    rebuilt.)

---

## 16. Container Supply-Chain Security

### The principle

Your container is mostly other people's code: a base OS, hundreds of Debian
packages, and (here) ~200 npm packages per service — every one a way in.
Supply-chain security is managing that inherited risk: choose minimal bases,
pin what you depend on, scan what you ship, run with least privilege, and
gate the pipeline on the result. Phase 6 adds the enforcement: hadolint lints
every Dockerfile, Trivy scans every built image and FAILS the build on
fixable CRITICAL/HIGH CVEs, and the prod overlay adds `no-new-privileges` to
every container.

### The minute sub-concepts

**What a scanner actually does.** Trivy inventories the image — OS package
database plus language lockfiles — and joins that inventory against CVE
databases. Two consequences: it can only see what's declared (a vendored
binary with no package entry is invisible), and results change over time
with no code change, because the CVE database moved. A scan is a statement
about *now*, which is why scheduled re-scans of shipped images matter as
much as build-time scans.

**The `ignore-unfixed` decision is policy, not laziness.** A CVE with no
released fix would block every build while offering no action to take.
Gating on *fixable* CRITICAL/HIGH means "you're blocked only when you can
act" — pragmatic and defensible. The complementary duty: track unfixed
findings (report artifacts, scheduled scans) rather than letting
ignore-unfixed become ignore-forever.

**Base image strategy is your biggest lever.** `node:20-bookworm-slim` (this
project) carries far fewer packages than full bookworm — a smaller inventory
is a smaller CVE surface. The next rungs: distroless (no shell, no package
manager — debugging cost) and static/scratch (Go-style, rarely for Node).
PROGRESS names distroless as the known next hardening step: stating the rung
you're on and the rung above it is the senior posture.

**Pinning: the reproducibility ↔ freshness tension.** Lockfiles pin npm
deps exactly (Phase 6's addition); the base image is pinned to `20-bookworm-
slim` (a moving tag within Node 20). Stricter is digest-pinning
(`node@sha256:…`) — bit-exact but now security updates require an explicit
bump, so digest-pinning without update automation (Renovate/Dependabot)
trades unknown risk for stale risk. Every layer pinned = reproducible;
reproducible + automated bumps = maintained.

**Least privilege inside the container.** The Dockerfiles already run as
`USER node` (non-root); prod adds `security_opt: no-new-privileges:true`,
which stops privilege escalation via setuid binaries even if the process is
compromised. The remaining honest gaps are named in the prod file itself:
default capabilities could be dropped, root FS could be read-only —
articulating the un-done items credibly beats claiming completeness.

**Beyond scanning: SBOM and provenance.** A Software Bill of Materials
(Trivy/Syft can emit CycloneDX/SPDX) answers the log4shell question — "which
of our images contain package X?" — from inventory instead of emergency
re-scans. Image signing (cosign) and build provenance (SLSA) close the loop:
prove the image in the registry is the one THIS pipeline built. Named here
as the next maturity rung; the pipeline's SHA-tagging is the primitive
they build on.

### Practical worked example

The gate, from the workflow:

```yaml
- uses: aquasecurity/trivy-action@0.24.0
  with:
    image-ref: local/${{ matrix.service }}:ci
    severity: CRITICAL,HIGH
    ignore-unfixed: true
    exit-code: '1'        # fail the pipeline, don't just report
```

And the defense-in-depth ladder this platform already climbs, bottom to top:
slim base → multi-stage build (dev deps never reach runtime — `npm prune
--omit=dev` in the build stage) → non-root `USER node` → lockfile-exact
installs → lint gate → CVE gate → `no-new-privileges` at runtime → internal-
only networks from Phase 1. Each layer assumes the one below it failed.

### 10 senior interview questions

1. **A scan that passed last month fails today with no code change. Why,
   and what does that imply about scanning strategy?** (CVE databases
   updated — the image didn't change, knowledge did. Implies scheduled
   re-scans of SHIPPED images + a patch cadence, not only build-time
   gating.)
2. **Defend gating on `ignore-unfixed: true` — and its failure mode.**
   (Blocking on unfixable CVEs stops delivery with no action available;
   gate where action exists. Failure mode: unfixed criticals accumulate
   unwatched — pair with tracked reporting and periodic review.)
3. **Slim vs distroless vs scratch for a Node service — walk the trade.**
   (Slim: small, still has shell/apt — debuggable, moderate surface;
   distroless: no shell/pkg manager — big surface cut, harder exec-debug
   (ephemeral debug containers); scratch: impractical for Node's dynamic
   linking. Choose per operational maturity.)
4. **Why does multi-stage build matter for SECURITY, not just size?**
   (Build tools, compilers, dev dependencies — with their own CVEs — never
   enter the runtime layer; `npm prune --omit=dev` plus copy-only-artifacts
   shrinks the exploitable inventory, not just megabytes.)
5. **What does digest-pinning the base image buy, and what new obligation
   does it create?** (Bit-exact reproducibility and immunity to tag
   repointing/registry compromise; obligation: automated bump PRs, or
   you've frozen yourself out of security patches.)
6. **Explain `no-new-privileges` and the attack it kills.** (Sets a kernel
   flag: execve can never grant more privileges — setuid/setcap binaries
   stop escalating. A compromised non-root process can't climb to root via
   a setuid helper.)
7. **Where would an SBOM have changed your log4shell week?** (Query the
   SBOM store for 'log4j-core' across all images → complete affected list
   in minutes; without it, emergency-rescan everything and hope registry
   history is complete.)
8. **The scanner is clean but you're still shipping malicious code. Name
   three ways.** (Typosquatted/hijacked npm package with no CVE yet;
   malicious install scripts; compromised CI injecting at build — CVE
   scanning only catches KNOWN vulnerabilities, hence provenance/signing
   and dependency review.)
9. **Non-root USER in the Dockerfile vs userns-remap vs rootless daemon —
   what does each protect?** (USER: process privileges inside container;
   userns-remap: container root maps to unprivileged host UID — contains
   breakout; rootless: the daemon itself unprivileged — contains daemon
   compromise. Different layers of the same onion.)
10. **Your registry is compromised and images repointed. Which Phase 6
    mechanisms help, which don't, and what's missing?** (SHA-referenced
    deploys resist tag repointing; :latest consumers are owned; scanning
    doesn't help at all. Missing rung: signature verification (cosign) at
    pull/admission time.)

---

## 17. Dev/Prod Parity and Configuration Layering

### The principle

Most deploy-day failures are not code — they're differences between the
environment you tested and the environment you run. Dev/prod parity
(12-factor III/X) says: keep the gap small, and where a gap must exist, make
it explicit, reviewable configuration. This platform's answer is compose
LAYERING: one base file states the invariant truth; small overlay files
state only what differs per context (data, dev conveniences, observability,
prod posture). Prod is `base + data + prod` — the same images, same
topology, same env KEYS as dev, with the dev override simply absent.

### The minute sub-concepts

**Layering by subtraction.** The design decision that pays off in Phase 6
was made in Phase 1: every debug port lives in the override file and ONLY
there. Prod therefore isn't a rewrite — it's an omission. Nobody audits a
port list to "remember to remove" debug exposure; the file not being on the
command line IS the removal. Config you don't have to remember is config
that can't be forgotten.

**Merge semantics are part of the contract.** Compose merges maps by key
(env overlays win per-variable) and APPENDS lists — which is why you can't
remove a port with a normal overlay. The `!override` tag replaces instead
of appending (Traefik keeps 80/443, loses the 8081 dashboard). Knowing
where merge semantics fight you — and the escape hatch — is the difference
between using layering and being used by it.

**Same shape, different values.** Prod parity does NOT mean identical
values: it means identical STRUCTURE. Both environments use the same env
keys (LOG_LEVEL, RABBITMQ_URL), the same secrets mechanism, the same
images; prod flips values (info-level logs, NODE_ENV=production) and adds
posture (no-new-privileges, log rotation). What must never differ per
environment: code, image bytes, dependency versions. What may: replicas,
endpoints, credentials, limits.

**Replicas exercise a seam built six phases ago.** `deploy.replicas: 2` on
the gateway works with zero other changes because Phase 1 left the seams:
Traefik discovers instances by label (no static upstream list), the gateway
holds no session state (JWT travels with the request), and no
container_name/host-port pins a service to being a singleton. Horizontal
scaling was a property of the architecture waiting for one line of config.

**The honest-gaps register.** The prod file documents its own limits:
guest/guest broker creds, self-signed certs, file-based secrets, compose's
partial enforcement of resource limits. This is deliberate: a "prod" label
with silent dev artifacts is a trap; a named-gaps register is an interview
answer ("here's what I'd change with a real secret manager and ACME").

**When layering graduates.** Compose overlays are one instance of a general
pattern — base + patches — that scales up to Kustomize overlays and Helm
values in Kubernetes. The skill transfers wholesale: keep the base
invariant, keep patches small and reviewable, never fork the base per
environment (forked bases drift, and drift is the original sin parity
exists to prevent).

### Practical worked example

The whole prod posture is visible in the chain difference:

```powershell
# dev (5 files' worth of conveniences):
docker compose -f docker-compose.yml -f docker-compose.data.yml `
  -f docker-compose.observability.yml -f docker-compose.override.yml up -d

# prod-like (override ABSENT, prod overlay present):
docker compose -f docker-compose.yml -f docker-compose.data.yml `
  -f docker-compose.prod.yml up -d --build
```

Verify the subtraction did its job:

```powershell
docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.prod.yml config | Select-String "published"
```

Exactly two published ports remain (80, 443). Then
`docker compose ... ps api-gateway` shows two replicas, and the Traefik
dashboard is gone — `curl.exe -s -o NUL -w "%{http_code}" http://localhost:8081/dashboard/` can't connect, because the port no longer exists.

### 10 senior interview questions

1. **Define dev/prod parity precisely — what must match, what may
   differ?** (Match: code, artifacts/image bytes, dependency versions,
   backing-service TYPES, config SHAPE. May differ: config VALUES —
   replicas, endpoints, credentials, limits. The 12-factor gaps to
   minimize: time, personnel, tools.)
2. **Why is removing debug ports by OMITTING a file safer than deleting
   lines for a prod copy?** (Forked files drift; omission is structural —
   the dangerous config was never reachable from the prod chain. Review
   surface shrinks from 'diff two big files' to 'which files are in the
   chain'.)
3. **Compose appends lists on merge. What does that break, and what are
   your options?** (You can't remove ports/volumes with a plain overlay —
   only add; options: keep removable things out of base (this project's
   choice), `!override`/`!reset` tags, or restructure layers so
   subtraction is never needed.)
4. **`deploy.replicas: 2` worked with zero code changes. Enumerate the
   preconditions that made that true.** (Stateless service — JWT not
   sessions; discovery by label not static config; no host-port binding
   on the replicated service; no container_name pinning; healthchecks so
   LB routes only to ready instances.)
5. **What's still dev-grade in this 'prod' overlay, and what's the real
   fix for each?** (guest/guest RabbitMQ → provisioned users/ACLs via
   definitions; self-signed TLS → ACME/managed certs; file secrets →
   secret manager injection; compose limits → orchestrator-enforced
   quotas.)
6. **Config in env vars vs baked into images vs config files — trade
   them.** (Env: 12-factor, per-env at deploy, but flat strings and
   process-visible; baked: violates parity — new image per env, breaks
   artifact promotion; files/mounts: structured + secret-manager friendly,
   more moving parts. Never bake.)
7. **Your staging works, prod fails, images identical. Where do you look,
   in order?** (Config values diff (env dump comparison), secrets/IAM,
   backing-service versions/data shape, network policy/DNS, resource
   limits triggering OOM/throttle — parity narrows the search space to
   exactly these.)
8. **How does this compose layering map to Kubernetes practice?** (Base
   manifests + Kustomize overlays ≈ base compose + env files; Helm
   values ≈ env-specific value injection; same invariants: one base, thin
   patches, artifact promotion across environments — the concepts
   transfer, only the tooling changes.)
9. **Someone proposes `docker-compose.prod.yml` as a full standalone copy
   'to be safe.' Argue against, steelman, then resolve.** (Against: drift,
   double-maintenance, silent divergence — the anti-parity outcome.
   Steelman: standalone is simpler to read and can't inherit surprises.
   Resolution: keep overlays thin + `compose config` renders the merged
   truth for review — readability without forking.)
10. **Prove, don't assert: how would you TEST that prod exposes only 80
    and 443?** (Render the merged config in CI (`compose config`) and
    assert on published ports programmatically — config-as-code gets
    tests too; that assertion is exactly what scripts/verify-phase6.ps1
    automates.)

---

# Phase 7 — Concept Deep-Dive

One concept underpins the storefront layer, covered with mechanics, a worked
example, and senior-level interview Q&A:

18. Serving a SPA behind a reverse proxy (static hosting, same-origin API, SPA routing)

---

## 18. Serving a SPA Behind a Reverse Proxy

### The principle

A single-page application is, at deploy time, just a folder of static files —
one `index.html`, a fingerprinted JS bundle, a CSS bundle. It has no server of
its own; it runs entirely in the browser and talks to the backend over HTTP.
The engineering questions are therefore: what serves those static files, how do
the browser's API calls reach the backend, and how does client-side routing
survive a page refresh. This platform answers all three with the edge it already
has: nginx serves the bundle, Traefik routes `app.localhost/api/*` to the
gateway so API calls are same-origin, and an nginx fallback rule makes deep links
work.

### The minute sub-concepts

**Build-time vs runtime for a SPA.** The React source is compiled ONCE at build
time (`vite build`) into static assets; there is no React "running" on a server.
This is why the runtime image is nginx, not Node — the multi-stage Dockerfile
builds with Node then throws Node away, shipping only nginx + the `dist` folder.
The final image's attack surface is nginx and static files: no application
runtime, no npm dependencies present at runtime at all.

**Same-origin vs CORS — a routing decision, not a code decision.** A browser
treats `app.localhost` and `api.localhost` as different origins; a call from one
to the other is cross-origin and triggers CORS preflights and headers. This
platform sidesteps CORS entirely by serving BOTH the UI and the API under one
origin: `app.localhost` serves the SPA, and `app.localhost/api/*` is routed to
the gateway by a higher-priority Traefik router. The browser sees one origin, so
there is no CORS to configure. The "fix" for CORS was an edge-routing choice, not
a header dance — which is the cleaner answer whenever you control the edge.

**Router priority resolves the overlap.** Two routers now match requests to
`app.localhost`: the SPA catch-all (`Host(app.localhost)`) and the API route
(`Host(app.localhost) && PathPrefix(/api)`). Both match a `/api/...` request, so
Traefik needs a tiebreaker: explicit `priority`. The API router is given higher
priority so `/api/*` wins and goes to the gateway; everything else falls through
to the SPA. Rule specificity plus explicit priority is how overlapping routes are
disambiguated in every reverse proxy.

**SPA routing and the refresh problem.** Client-side routing means the URL
`/products/BOOK-001` is handled by JavaScript in the browser — but if the user
refreshes, the browser asks the SERVER for `/products/BOOK-001`, which doesn't
exist as a file. Without handling, that's a 404. The fix is the nginx
`try_files $uri $uri/ /index.html` rule: serve the file if it exists, otherwise
serve `index.html` and let the client router take over. Every statically-hosted
SPA needs this fallback; forgetting it is the classic "works until you refresh"
bug.

**Cache strategy follows the fingerprint.** Vite emits assets with content
hashes in their names (`index-8G9FJAtQ.js`). Because the name changes whenever
the content changes, those files can be cached forever (`Cache-Control:
immutable`) — a new deploy produces new names, so there's no stale-cache risk.
`index.html` itself, which references the hashed files, must NOT be long-cached,
or browsers would load an old index pointing at deleted bundles. This split —
immutable assets, always-revalidate HTML — is the standard SPA caching contract.

**The token lives in the browser, and that has consequences.** The JWT from
login is held in the SPA (here, `sessionStorage`) and attached to protected
calls. This is a deliberate, discussable trade-off: `sessionStorage`/
`localStorage` are readable by any JS on the page, so they're vulnerable to XSS
but immune to CSRF; an `HttpOnly` cookie is the reverse (immune to XSS
exfiltration, but needs CSRF protection). For a portfolio demo the storage
approach is fine; naming the trade-off is the senior signal.

**The UI is just another service behind the edge.** The storefront gets the same
treatment as every backend service: multi-stage build, non-root runtime,
healthcheck, resource limits, Traefik labels, a slot in the CI matrices, and
inclusion in the compose smoke boot. Nothing about it being "the frontend" makes
it special to the platform — it's a container with a route, which is exactly how
it should be.

### Practical worked example

The same-origin trick is entirely in Traefik labels — no application code knows
about it:

```yaml
# SPA catch-all (low priority)
- "traefik.http.routers.storefront.rule=Host(`app.localhost`)"
- "traefik.http.routers.storefront.priority=1"
- "traefik.http.services.storefront.loadbalancer.server.port=8080"
# API on the SAME host (high priority) -> points at the gateway service
- "traefik.http.routers.storefront-api.rule=Host(`app.localhost`) && PathPrefix(`/api`)"
- "traefik.http.routers.storefront-api.priority=10"
- "traefik.http.routers.storefront-api.service=gateway"
```

So the browser's `fetch('/api/auth/login')` is same-origin (no CORS), hits
Traefik, matches the higher-priority API router, and is proxied to the gateway —
which validates the JWT and forwards to the auth service. The SPA's API client is
correspondingly trivial: every call is to a relative `/api/...` path with no host,
no CORS mode, no credentials juggling.

The SPA-refresh fallback is one nginx directive:

```nginx
location / { try_files $uri $uri/ /index.html; }
```

Refresh `https://app.localhost/anything` and nginx serves `index.html`; the React
router then renders the right view.

### 10 senior interview questions

1. **A SPA is "just static files" — so why is the runtime image nginx and not
   Node?** (Because there's nothing to run server-side: the bundle executes in
   the browser. nginx serves files with a tiny attack surface; keeping Node would
   ship an unused runtime and its CVEs. The multi-stage build uses Node only to
   compile, then discards it.)
2. **Your frontend calls the backend and you see CORS errors. Give two fixes and
   pick one for a system where you own the edge.** (Configure CORS headers on the
   backend, OR serve UI and API under one origin via the reverse proxy. If you
   own the edge, same-origin routing is cleaner — no preflights, no header
   maintenance, one origin to reason about.)
3. **Two Traefik routers match the same host. How is the winner chosen, and how
   do you make it deterministic?** (Rule specificity contributes, but rely on
   explicit `priority`: the more specific `PathPrefix(/api)` router gets higher
   priority so it wins for /api/*, and the catch-all handles the rest.)
4. **A user refreshes on /orders/123 and gets a 404. What's wrong and what's the
   fix?** (The server has no file at that path — client-side routes aren't files.
   Fix: SPA fallback (`try_files ... /index.html`) so the server returns the app
   shell and the client router resolves the path.)
5. **Design the cache headers for a Vite build and justify each.** (Hashed
   `/assets/*` are immutable -> `Cache-Control: public, immutable, max-age=1y`
   since a content change changes the name; `index.html` -> no-cache/short TTL so
   it always points at the current bundle names. Long-caching index.html strands
   users on deleted assets.)
6. **Where do you store the JWT in a browser SPA, and what's the trade-off
   matrix?** (localStorage/sessionStorage: simple, XSS-exposed, CSRF-immune;
   HttpOnly cookie: XSS-safe for exfiltration, needs CSRF defense, sent
   automatically. Choice depends on threat model; the honest answer names both
   risks rather than claiming one is "secure".)
7. **How do you inject environment-specific config (API base URL, feature flags)
   into a static SPA that's already built?** (Options: build-time env baked into
   the bundle (simple, needs rebuild per env — breaks artifact promotion); or a
   runtime config.json / templated env fetched at startup (one artifact across
   envs). The same-origin design here sidesteps the API-URL case entirely — it's
   always relative /api.)
8. **The SPA container passed the image scan but you're still worried about
   frontend supply chain. What's the residual risk scanners miss?** (The npm deps
   were compiled INTO the bundle at build time — a malicious/compromised
   dependency's code ships inside the JS even though it's not a runtime package
   the scanner sees. Mitigations: lockfile pinning, dependency review, SRI,
   build-time SBOM of the frontend tree.)
9. **How would you scale the storefront, and why is it trivial compared to a
   stateful service?** (It's static files — run N nginx replicas behind Traefik,
   or push the assets to a CDN/object store entirely. No state, no coordination;
   the hard scaling problems live in the stateful backend services, not here.)
10. **Walk a request for https://app.localhost/api/orders from browser to
    database.** (Browser fetch (same-origin) -> Traefik terminates TLS, matches
    the high-priority /api router -> gateway validates the JWT, injects x-user-id,
    proxies to the order service -> order service writes to Postgres and the
    outbox in one transaction, returns 202. The UI never touched a backend
    directly; every hop is the same path the CLI verify scripts exercise.)
