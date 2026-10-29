import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { JWK } from "jose";
import { randomUUID } from "node:crypto";
import { verifyReceipt, type Quote, type ReceiptClaims } from "@agent-tab/shared";

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
  /** Share across routes so a receipt cannot be replayed on a sibling route. */
  nonceStore?: Set<string>;
};

const quotes = new Map<string, Quote>();
const defaultNonces = new Set<string>();

function sweep(now: number) {
  for (const [id, q] of quotes) if (Date.parse(q.expires_at) <= now) quotes.delete(id);
}

/**
 * Express middleware implementing the seller side of Agent Tab.
 * No receipt  -> 402 + a one-time quote.
 * Receipt     -> verify signature, merchant, quote, price, nonce; then next().
 */
export function requirePayment(opts: RequirePaymentOptions): RequestHandler {
  const ttl = (opts.quoteTtlSeconds ?? 300) * 1000;
  const nonces = opts.nonceStore ?? defaultNonces;

  return async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);
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
      quotes.set(quote.quote_id, quote);
      res.status(402).set("Cache-Control", "no-store").json({ error: "payment_required", quote });
      return;
    }

    let claims: ReceiptClaims;
    try {
      claims = await verifyReceipt(auth.slice(4).trim(), opts.publicKeyJwk);
    } catch {
      res.status(401).json({ error: "invalid_receipt" });
      return;
    }
    if (claims.merchant_id !== opts.merchantId) { res.status(403).json({ error: "wrong_merchant" }); return; }
    const quote = quotes.get(claims.quote_id);
    if (!quote) { res.status(403).json({ error: "unknown_or_used_quote" }); return; }
    if (Date.parse(quote.expires_at) <= now) { quotes.delete(claims.quote_id); res.status(403).json({ error: "quote_expired" }); return; }
    if (claims.price !== quote.price) { res.status(403).json({ error: "price_mismatch" }); return; }
    if (nonces.has(claims.nonce)) { res.status(409).json({ error: "replayed_receipt" }); return; }

    nonces.add(claims.nonce);
    quotes.delete(claims.quote_id); // single use
    res.locals.tab = claims;
    try {
      await opts.onUsage?.(claims, req);
    } catch {
      /* usage recording must never block serving */
    }
    next();
  };
}
