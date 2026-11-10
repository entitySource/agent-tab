import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
// Load .env from the current directory first, then from the repo root, so every app works
// whether started from the root, its own folder, or compiled dist/.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { createServer, type RequestListener } from "node:http";
import type { JWK } from "jose";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? process.env.PAID_API_PORT ?? 4200);
const merchantId = process.env.PAID_API_MERCHANT_ID ?? "research-data-demo";
const raw = process.env.TAB_SERVICE_URL ?? "http://localhost:4100";
const tabServiceUrl = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;

// Bind the port immediately so the host's health check passes even while the tab service
// is unreachable. Until the receipt key arrives, /health reports ready:false and every
// other route answers 503 instead of serving unpaid data.
const handler: { app?: RequestListener } = {};
createServer((req, res) => {
  if (handler.app) return handler.app(req, res);
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, ready: false, merchant_id: merchantId, waiting_for: tabServiceUrl }));
    return;
  }
  res.statusCode = 503;
  res.setHeader("retry-after", "5");
  res.end(JSON.stringify({ error: "starting", detail: "waiting for the tab service's receipt key" }));
}).listen(port, "0.0.0.0", () => console.log(`[paid-api] merchant ${merchantId} listening on http://localhost:${port}`));

// The seller trusts receipts signed by the tab service; fetch its public key, retrying
// rather than crashing because a free host may still be waking the tab service up.
async function fetchPublicKey(): Promise<JWK> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${tabServiceUrl}/.well-known/agent-tab.json`, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) return ((await r.json()) as { receipt_public_key_jwk: JWK }).receipt_public_key_jwk;
      console.warn(`[paid-api] tab service answered ${r.status}; retrying (${attempt})`);
    } catch (err) {
      console.warn(`[paid-api] tab service not reachable at ${tabServiceUrl} (${(err as Error).message}); retrying (${attempt})`);
    }
    await new Promise((res) => setTimeout(res, Math.min(2_000 * attempt, 15_000)));
  }
}

const onUsage = (c: { quote_id: string; price: number; tab_id: string }) => console.log(`[paid-api] served ${c.quote_id} for $${c.price} on tab ${c.tab_id}`);
let currentKeyX = "";
function install(key: JWK) {
  currentKeyX = String(key.x);
  handler.app = createApp(key, merchantId, onUsage);
}

install(await fetchPublicKey());
console.log(`[paid-api] receipt key loaded from ${tabServiceUrl}; serving paid routes`);

// The tab service may restart with a different signing key (for example a host that has no
// fixed key configured). Re-check periodically and swap in the new key, so receipts keep
// verifying without restarting this seller. Quotes issued before the swap stay valid because
// the quote store is shared across app instances.
const KEY_REFRESH_MS = Number(process.env.RECEIPT_KEY_REFRESH_MS ?? 60_000);
setInterval(async () => {
  try {
    const r = await fetch(`${tabServiceUrl}/.well-known/agent-tab.json`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return;
    const key = ((await r.json()) as { receipt_public_key_jwk: JWK }).receipt_public_key_jwk;
    if (key?.x && String(key.x) !== currentKeyX) {
      install(key);
      console.warn("[paid-api] tab service receipt key changed; now verifying with the new key");
    }
  } catch {
    /* tab service asleep or unreachable; keep the current key */
  }
}, KEY_REFRESH_MS).unref();
