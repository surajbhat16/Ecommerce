// ────────────────────────────────────────────────────────────────────────────
// api.ts — the storefront's client for the platform gateway.
//
// Every call is same-origin to /api/* — Traefik routes those to the gateway,
// which validates the JWT and proxies to the right service. The browser never
// talks to a service directly, which is the whole point of the edge/gateway
// split: one origin, one auth boundary, no CORS.
// ────────────────────────────────────────────────────────────────────────────

const BASE = '/api';

// The catalog has no "list all" route — only /categories/:category/products.
// These are the three seeded categories.
export const CATEGORIES = ['books', 'apparel', 'electronics'] as const;

export interface Product {
  sku: string;
  name: string;
  description: string;
  category: string;
  priceCents: number;
  currency: string;
  attributes: Record<string, unknown>;
}

export interface CartItem { sku: string; quantity: number; }

export interface Order {
  id: string;
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'FAILED' | 'REJECTED';
  total_cents: number;
  created_at: string;
}

let token: string | null = sessionStorage.getItem('token');
export const getToken = () => token;
export const isAuthed = () => !!token;

function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const b = await res.json(); msg = b.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function register(email: string, password: string): Promise<void> {
  await j(await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
}

export async function login(email: string, password: string): Promise<void> {
  const data = await j<{ accessToken: string }>(await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  token = data.accessToken;
  sessionStorage.setItem('token', token);
}

export function logout(): void {
  token = null;
  sessionStorage.removeItem('token');
}

// ── Catalog (public) ────────────────────────────────────────────────────────
export async function productsByCategory(category: string): Promise<Product[]> {
  const data = await j<{ products: Product[] }>(
    await fetch(`${BASE}/catalog/categories/${category}/products`),
  );
  return data.products;
}

export async function allProducts(): Promise<Product[]> {
  const lists = await Promise.all(CATEGORIES.map(productsByCategory));
  return lists.flat();
}

// ── Cart (protected) ──────────────────────────────────────────────────────────
// The gateway rewrites /api/cart/* -> /cart/* before proxying to the cart
// service (see services/gateway rewritePrefix: '/cart'), and the cart service
// itself serves its routes at /cart and /cart/items — so the client only ever
// needs a single /cart segment, not /cart/cart.
export async function getCart(): Promise<CartItem[]> {
  const data = await j<{ items?: CartItem[] }>(
    await fetch(`${BASE}/cart`, { headers: authHeaders() }),
  );
  return data.items ?? [];
}

export async function addToCart(sku: string, quantity: number): Promise<void> {
  await j(await fetch(`${BASE}/cart/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ sku, quantity }),
  }));
}

export async function removeFromCart(sku: string): Promise<void> {
  await j(await fetch(`${BASE}/cart/items/${sku}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }));
}

// ── Orders / the saga (protected) ───────────────────────────────────────────
export async function placeOrder(items: CartItem[]): Promise<string> {
  const data = await j<{ orderId: string }>(await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ items }),
  }));
  return data.orderId;
}

export async function getOrder(id: string): Promise<Order> {
  const data = await j<{ order: Order }>(
    await fetch(`${BASE}/orders/${id}`, { headers: authHeaders() }),
  );
  return data.order;
}
