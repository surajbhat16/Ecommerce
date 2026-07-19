import { useEffect, useState, useCallback } from 'react';
import * as api from './api';
import type { Product, CartItem, Order } from './api';

// The saga steps we narrate as the order progresses. These mirror the real
// event flow in the platform; the panel lights each up as the order advances.
const SAGA_NARRATION: Record<string, { svc: string; evt: string }[]> = {
  CONFIRMED: [
    { svc: 'order', evt: 'order created (PENDING) + outbox order.created' },
    { svc: 'inventory', evt: 'stock reserved -> inventory.reserved' },
    { svc: 'order', evt: 'status -> AWAITING_PAYMENT' },
    { svc: 'payment', evt: 'payment authorized -> payment.succeeded' },
    { svc: 'order', evt: 'status -> CONFIRMED' },
  ],
  FAILED: [
    { svc: 'order', evt: 'order created (PENDING) + outbox order.created' },
    { svc: 'inventory', evt: 'stock reserved -> inventory.reserved' },
    { svc: 'order', evt: 'status -> AWAITING_PAYMENT' },
    { svc: 'payment', evt: 'payment declined -> payment.failed' },
    { svc: 'order', evt: 'COMPENSATE: status -> FAILED + inventory.release' },
    { svc: 'inventory', evt: 'reserved stock released (rollback)' },
  ],
  REJECTED: [
    { svc: 'order', evt: 'order created (PENDING) + outbox order.created' },
    { svc: 'inventory', evt: 'insufficient stock -> inventory.rejected' },
    { svc: 'order', evt: 'status -> REJECTED (payment never called)' },
  ],
};

function money(cents: number) { return '$' + (cents / 100).toFixed(2); }

// ── Auth gate ─────────────────────────────────────────────────────────────
function AuthGate({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(''); setBusy(true);
    try {
      if (mode === 'register') { await api.register(email, password); }
      await api.login(email, password);
      onDone();
    } catch (e) { setErr((e as Error).message === '409' ? 'That email is already registered.' : `Could not ${mode}: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
      <p>Browsing is open. Sign in to build a cart and place an order.</p>
      {err && <div className="err">{err}</div>}
      <input placeholder="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      <input placeholder="password" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      <button onClick={submit} disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register & sign in'}</button>
      <div className="switch">
        {mode === 'login'
          ? <>New here? <button onClick={() => { setMode('register'); setErr(''); }}>Create an account</button></>
          : <>Have an account? <button onClick={() => { setMode('login'); setErr(''); }}>Sign in</button></>}
      </div>
    </div>
  );
}

// ── The saga panel — the signature element ──────────────────────────────────
function SagaPanel({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [litSteps, setLitSteps] = useState(0);

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    const poll = async () => {
      try {
        const o = await api.getOrder(orderId);
        if (!alive) return;
        setOrder(o);
        const terminal = ['CONFIRMED', 'FAILED', 'REJECTED'].includes(o.status);
        if (!terminal && Date.now() - started < 20000) { setTimeout(poll, 700); }
      } catch { if (alive && Date.now() - started < 20000) setTimeout(poll, 700); }
    };
    poll();
    return () => { alive = false; };
  }, [orderId]);

  // Once terminal, reveal the narration steps one by one.
  const terminalStatus = order && ['CONFIRMED', 'FAILED', 'REJECTED'].includes(order.status) ? order.status : null;
  useEffect(() => {
    if (!terminalStatus) return;
    const steps = SAGA_NARRATION[terminalStatus];
    let i = 0;
    const t = setInterval(() => { i += 1; setLitSteps(i); if (i >= steps.length) clearInterval(t); }, 420);
    return () => clearInterval(t);
  }, [terminalStatus]);

  const status = order?.status ?? 'PENDING';
  const steps = terminalStatus ? SAGA_NARRATION[terminalStatus] : SAGA_NARRATION.CONFIRMED.slice(0, 1);

  return (
    <div className="saga-overlay" onClick={onClose}>
      <div className="saga" onClick={e => e.stopPropagation()}>
        <h3>Checkout saga</h3>
        <div className="oid">order {orderId}</div>
        <span className={`state-badge badge-${status}`}>{status}</span>
        <div className="hint">
          {terminalStatus
            ? 'The order reached a terminal state. Each line below is a real event that crossed the message broker.'
            : 'Running the distributed transaction across order, inventory, and payment…'}
        </div>
        <div className="timeline">
          {steps.map((s, idx) => (
            <div key={idx} className={`step ${idx < litSteps ? 'on' : ''}`}>
              <div className="dot" />
              <div className="svc">{s.svc}</div>
              <div className="evt">{s.evt}</div>
            </div>
          ))}
        </div>
        <a className="trace-link" href="http://localhost:16686" target="_blank" rel="noreferrer">
          → open this trace in Jaeger
        </a>
        <div style={{ height: 14 }} />
        <button className="close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ── Main app ────────────────────────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(api.isAuthed());
  const [category, setCategory] = useState<string>('all');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [sagaOrder, setSagaOrder] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  useEffect(() => {
    setLoading(true);
    (category === 'all' ? api.allProducts() : api.productsByCategory(category))
      .then(setProducts).catch(() => flash('Could not load catalog'))
      .finally(() => setLoading(false));
  }, [category]);

  const refreshCart = useCallback(() => {
    if (!authed) return;
    api.getCart().then(setCart).catch(() => { /* empty cart is fine */ });
  }, [authed]);

  useEffect(() => { refreshCart(); }, [refreshCart]);

  async function add(sku: string) {
    try { await api.addToCart(sku, 1); flash(`Added ${sku}`); refreshCart(); }
    catch (e) { flash((e as Error).message); }
  }
  async function remove(sku: string) {
    try { await api.removeFromCart(sku); refreshCart(); } catch (e) { flash((e as Error).message); }
  }
  async function checkout(items?: CartItem[]) {
    const toOrder = items ?? cart;
    if (toOrder.length === 0) return;
    try {
      const orderId = await api.placeOrder(toOrder);
      setSagaOrder(orderId);
      if (!items) { for (const it of cart) await api.removeFromCart(it.sku).catch(() => {}); refreshCart(); }
    } catch (e) { flash(`Checkout failed: ${(e as Error).message}`); }
  }

  const productBySku = (sku: string) => products.find(p => p.sku === sku);

  if (!authed) {
    return (
      <>
        <header>
          <div className="brand"><h1>Meridian</h1><span className="tag">distributed storefront</span></div>
        </header>
        <AuthGate onDone={() => { setAuthed(true); }} />
      </>
    );
  }

  return (
    <>
      <header>
        <div className="brand"><h1>Meridian</h1><span className="tag">distributed storefront</span></div>
        <div className="header-actions">
          <span className="who">signed in</span>
          <button className="ghost" onClick={() => { api.logout(); setAuthed(false); setCart([]); }}>Sign out</button>
        </div>
      </header>

      <main>
        <section className="catalog">
          <h2>Catalog</h2>
          <div className="cats">
            {['all', ...api.CATEGORIES].map(c => (
              <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>
            ))}
          </div>
          {loading ? <p className="empty">Loading catalog…</p> : (
            <div className="grid">
              {products.map(p => (
                <div className="card" key={p.sku}>
                  <span className="sku">{p.sku}</span>
                  <span className="name">{p.name}</span>
                  <span className="desc">{p.description}</span>
                  <div className="attrs">
                    {Object.entries(p.attributes).slice(0, 3).map(([k, v]) => (
                      <div key={k}>{k}: {Array.isArray(v) ? v.join(', ') : String(v)}</div>
                    ))}
                  </div>
                  <div className="row">
                    <span className="price">{money(p.priceCents)}</span>
                    <button className="add" onClick={() => add(p.sku)}>Add to cart</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside>
          <h2>Cart</h2>
          {cart.length === 0 ? <div className="empty">Your cart is empty. Add something to place an order.</div> : (
            <>
              {cart.map(it => {
                const p = productBySku(it.sku);
                return (
                  <div className="cart-line" key={it.sku}>
                    <div>
                      <div className="sku">{it.sku}</div>
                      {p && <div className="qty">{p.name}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="qty">×{it.quantity}</span>
                      <button onClick={() => remove(it.sku)}>remove</button>
                    </div>
                  </div>
                );
              })}
              <button className="checkout" onClick={() => checkout()}>Place order</button>
            </>
          )}

          <div className="demos">
            <p>Demo saga paths</p>
            <button className="ghost" onClick={() => checkout([{ sku: 'BOOK-001', quantity: 1 }])}>BOOK-001 ×1 → CONFIRMED</button>
            <button className="ghost" onClick={() => checkout([{ sku: 'LAPTOP-001', quantity: 1 }])}>LAPTOP-001 ×1 → FAILED (compensated)</button>
            <button className="ghost" onClick={() => checkout([{ sku: 'LAPTOP-001', quantity: 3 }])}>LAPTOP-001 ×3 → REJECTED</button>
          </div>
        </aside>
      </main>

      {sagaOrder && <SagaPanel orderId={sagaOrder} onClose={() => setSagaOrder(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
