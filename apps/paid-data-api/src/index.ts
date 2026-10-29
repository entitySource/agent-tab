import "dotenv/config";
import type { JWK } from "jose";
import { createApp } from "./app.js";

const port = Number(process.env.PAID_API_PORT ?? 4200);
const merchantId = process.env.PAID_API_MERCHANT_ID ?? "research-data-demo";
const raw = process.env.TAB_SERVICE_URL ?? "http://localhost:4100";
const tabServiceUrl = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;

// The seller trusts receipts signed by the tab service; fetch its public key once at boot.
const wk = (await fetch(`${tabServiceUrl}/.well-known/agent-tab.json`).then((r) => r.json())) as { receipt_public_key_jwk: JWK };

createApp(wk.receipt_public_key_jwk, merchantId, (c) => console.log(`[paid-api] served ${c.quote_id} for $${c.price} on tab ${c.tab_id}`))
  .listen(port, () => console.log(`[paid-api] merchant ${merchantId} listening on http://localhost:${port}`));
