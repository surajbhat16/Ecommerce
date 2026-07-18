// ─────────────────────────────────────────────────────────────────────────────
// seed.js — runs automatically on first Mongo startup.
//
// The official mongo image executes any *.js files mounted into
// /docker-entrypoint-initdb.d/ against the database on first init. We use it to
// insert a few sample products with DIFFERENT attribute shapes per category —
// which showcases exactly why a document store fits the catalog.
// ─────────────────────────────────────────────────────────────────────────────

db = db.getSiblingDB('catalogdb');

db.products.insertMany([
  {
    sku: 'BOOK-001',
    name: 'The Pragmatic Programmer',
    description: 'Classic software engineering book.',
    category: 'books',
    priceCents: 3999,
    currency: 'USD',
    // Book-specific attributes:
    attributes: { isbn: '978-0135957059', pages: 352, author: 'Hunt & Thomas' },
    createdAt: new Date(),
  },
  {
    sku: 'SHIRT-001',
    name: 'Cotton T-Shirt',
    description: 'Comfortable everyday tee.',
    category: 'apparel',
    priceCents: 1999,
    currency: 'USD',
    // Apparel-specific attributes — a totally different shape:
    attributes: { sizes: ['S', 'M', 'L', 'XL'], colors: ['black', 'white'], material: 'cotton' },
    createdAt: new Date(),
  },
  {
    sku: 'LAPTOP-001',
    name: 'UltraBook 14',
    description: 'Lightweight developer laptop.',
    category: 'electronics',
    priceCents: 129999,
    currency: 'USD',
    // Electronics-specific attributes — different again:
    attributes: { ramGb: 16, cpu: 'M-series', storageGb: 512, ports: ['USB-C', 'HDMI'] },
    createdAt: new Date(),
  },
]);

print('Seeded ' + db.products.countDocuments() + ' products');
