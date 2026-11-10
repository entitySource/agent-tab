import express from "express";
import type { JWK } from "jose";
import { NonceStore, requirePayment } from "@agent-tab/server";
import type { ReceiptClaims } from "@agent-tab/shared";
import { DOCS, search, summary } from "./data.js";

export const PRICES = { search: 0.05, doc: 0.1, summary: 0.25, export: 9.0 } as const;

export function createApp(publicKeyJwk: JWK, merchantId: string, onUsage?: (c: ReceiptClaims) => void) {
  const app = express();
  const nonceStore = new NonceStore();
  const paid = (price: number) => requirePayment({ price, merchantId, publicKeyJwk, nonceStore, onUsage });

  app.get("/health", (_req, res) => res.json({ ok: true, merchant_id: merchantId, prices: PRICES }));

  app.get("/v1/search", paid(PRICES.search), (req, res) => {
    const q = String(req.query.q ?? "");
    res.json({ query: q, results: search(q) });
  });

  app.get("/v1/docs/:id", paid(PRICES.doc), (req, res) => {
    const doc = DOCS.find((d) => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: "not_found" }); return; }
    res.json(doc);
  });

  app.get("/v1/summary/:topic", paid(PRICES.summary), (req, res) => {
    const s = summary(req.params.topic);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    res.json(s);
  });

  /** Whole-dataset export. Priced so a sane per-call cap blocks it: the "$900 item on a $50 budget" moment. */
  app.get("/v1/export", paid(PRICES.export), (_req, res) => {
    res.json({ docs: DOCS });
  });

  return app;
}
