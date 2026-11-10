import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { JWK } from "jose";
import { randomUUID } from "node:crypto";
import { verifyReceipt, type Quote, type ReceiptClaims } from "@agent-tab/shared";

/**
 * Remembers receipt nonces until the receipt itself expires. After that a replay is
 * already rejected by the signature check (expired JWT), so the entry can be dropped.
 * This keeps memory bounded instead of growing with every paid request.
 */
export class NonceStore {
  private readonly seen = new Map<string, number>(); // nonce -> expiry (epoch ms)
  private lastSweep = 0;
  constructor(private readonly maxEntries = 100_000) {}

  has(nonce: string, now = Date.now()): boolean {
    const exp = this.seen.get(nonce);
    return exp !== undefined && exp > now;
  }

  add(nonce: string, expiresAtMs: number, now = Date.now()): void {
    if (now - this.lastSweep > 1_000) this.sweep(now);
    // Hard cap as a last resort; Map iterates in insertion order, so this drops the oldest.
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.seen.set(nonce, expiresAtMs);
  }

  sweep(now = Date.now()): void {
    this.lastSweep = now;
    for (const [nonce, exp] of this.seen) if (exp <= now) this.seen.delete(nonce);
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Outstanding quotes, bounded the same way so unauthenticated 402s cannot exhaust memory. */
class QuoteStore {
  private readonly quotes = new Map<string, Quote>();
  constructor(private readonly maxEntries = 50_000) {}
  get(id: string) { return this.quotes.get(id); }
  delete(id: string) { this.quotes.delete(id); }
  add(q: Quote, now = Date.now()) {
    for (const [id, existing] of this.quotes) {
      if (Date.parse(existing.expires_at) > now) break; // insertion order ~ expiry order
      this.quotes.delete(id);
    }
    while (this.quotes.size >= this.maxEntries) {
      const oldest = this.quotes.keys().next().value;
      if (oldest === undefined) break;
      this.quotes.delete(oldest);
    }
    this.quotes.set(q.quote_id, q);
  }
}

export type RequirePaymentOptions = {
  /** Price in USD for this resource. */
  price: number;
  /** Merchant id the tab service must have on its allowlist. */
  merchantId: string;
  /** Tab service public key used to verify line receipts. */
  publicKeyJwk: JWK;
  quoteTtlSeconds?: number;
  /** Called once per paid request after verification; use it to record usage. */
  onUsage?: (claims: ReceiptClaims, req: Request) => void | Promise<void>;
  /** Share one store across all routes of a seller so a receipt is spent exactly once. */
  nonceStore?: NonceStore;
};

const sharedQuotes = new QuoteStore();
const defaultNonces = new NonceStore();

/**
 * Express middleware implementing the seller side of Agent Tab.
 * No receipt -> 402 + a one-time quote bound to this exact route and price.
 * Receipt    -> verify signature, then that the quote it pays for was issued for THIS
 *               resource at THIS route's price by THIS merchant, then the nonce; then next().
 */
export function requirePayment(opts: RequirePaymentOptions): RequestHandler {
  const ttl = (opts.quoteTtlSeconds ?? 300) * 1000;
  const nonces = opts.nonceStore ?? defaultNonces;

  return async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const auth = req.header("authorization") ?? "";

    if (!auth.startsWith("Tab ")) {
      const quote: Quote = {
        quote_id: randomUUID(),
        merchant_id: opts.merchantId,
        price: opts.price,
        currency: "USD",
        resource: req.originalUrl,
        expires_at: new Date(now + ttl).toISOString(),
      };
      sharedQuotes.add(quote, now);
      res.status(402).set("Cache-Control", "no-store").json({ error: "payment_required", quote });
      return;
    }

    let claims: ReceiptClaims & { exp: number };
    try {
      claims = await verifyReceipt(auth.slice(4).trim(), opts.publicKeyJwk);
    } catch {
      res.status(401).json({ error: "invalid_receipt" });
      return;
    }
    if (claims.merchant_id !== opts.merchantId) { res.status(403).json({ error: "wrong_merchant" }); return; }
    const quote = sharedQuotes.get(claims.quote_id);
    if (!quote) { res.status(403).json({ error: "unknown_or_used_quote" }); return; }
    if (Date.parse(quote.expires_at) <= now) { sharedQuotes.delete(claims.quote_id); res.status(403).json({ error: "quote_expired" }); return; }
    // The receipt must pay for this route, not a cheaper sibling. All three must agree:
    // the price the receipt signed, the quote's price, and this route's configured price.
    if (quote.merchant_id !== opts.merchantId) { res.status(403).json({ error: "wrong_merchant" }); return; }
    if (quote.resource !== req.originalUrl) { res.status(403).json({ error: "wrong_resource" }); return; }
    if (claims.price !== quote.price || quote.price !== opts.price) { res.status(403).json({ error: "price_mismatch" }); return; }
    if (nonces.has(claims.nonce, now)) { res.status(409).json({ error: "replayed_receipt" }); return; }

    nonces.add(claims.nonce, claims.exp * 1000, now);
    sharedQuotes.delete(claims.quote_id); // single use
    res.locals.tab = claims;
    try {
      await opts.onUsage?.(claims, req);
    } catch {
      /* usage recording must never block serving */
    }
    next();
  };
}
