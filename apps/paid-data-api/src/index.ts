import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
// Load .env from the current directory first, then from the repo root, so every app works
// whether started from the root, its own folder, or compiled dist/.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import type { JWK } from "jose";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? process.env.PAID_API_PORT ?? 4200);
const merchantId = process.env.PAID_API_MERCHANT_ID ?? "research-data-demo";
const raw = process.env.TAB_SERVICE_URL ?? "http://localhost:4100";
const tabServiceUrl = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;

// The seller trusts receipts signed by the tab service; fetch its public key at boot.
// Retry rather than crash: on a free host the tab service may still be waking up.
async function fetchPublicKey(): Promise<JWK> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${tabServiceUrl}/.well-known/agent-tab.json`);
      if (r.ok) return ((await r.json()) as { receipt_public_key_jwk: JWK }).receipt_public_key_jwk;
      console.warn(`[paid-api] tab service answered ${r.status}; retrying (${attempt})`);
    } catch (err) {
      console.warn(`[paid-api] tab service not reachable at ${tabServiceUrl} (${(err as Error).message}); retrying (${attempt})`);
    }
    await new Promise((res) => setTimeout(res, Math.min(2_000 * attempt, 15_000)));
  }
}
const wk = { receipt_public_key_jwk: await fetchPublicKey() };

createApp(wk.receipt_public_key_jwk, merchantId, (c) => console.log(`[paid-api] served ${c.quote_id} for $${c.price} on tab ${c.tab_id}`))
  .listen(port, "0.0.0.0", () => console.log(`[paid-api] merchant ${merchantId} listening on http://localhost:${port}`));
