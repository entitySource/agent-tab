import "dotenv/config";
import { createApp, loadOrCreateKeys } from "./app.js";

const port = Number(process.env.TAB_SERVICE_PORT ?? 4100);
const keys = await loadOrCreateKeys();
createApp(keys).listen(port, () => {
  console.log(`[tab-service] listening on http://localhost:${port}`);
  console.log(`[tab-service] public key at /.well-known/agent-tab.json`);
});
// TODO(Nov 2): settlement job — one Orders v2 create+capture with payment_source.paypal.vault_id.
// TODO(Nov 3): treasurer — deterministic rule + LLM rationale (LLM may only settle earlier).
