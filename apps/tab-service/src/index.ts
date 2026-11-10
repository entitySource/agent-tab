import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
// Load .env from the current directory first, then from the repo root, so every app works
// whether started from the root, its own folder, or compiled dist/.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { createApp, loadOrCreateKeys } from "./app.js";
import { MockGateway, PayPalGateway } from "./gateway.js";
import { createAnthropicAdvisor } from "./advisor.js";

const port = Number(process.env.PORT ?? process.env.TAB_SERVICE_PORT ?? 4100);
const allowedVaultIds = (process.env.VAULT_IDS ?? process.env.VAULT_ID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const keys = await loadOrCreateKeys();
const gateway = PayPalGateway.fromEnv() ?? new MockGateway();
const advisor = await createAnthropicAdvisor();

const app = createApp(keys, undefined, { gateway, advisor, allowedVaultIds });
app.listen(port, "0.0.0.0", () => {
  console.log(`[tab-service] listening on http://localhost:${port}`);
  console.log(`[tab-service] gateway=${gateway.name} advisor=${advisor ? "anthropic" : "template"} linked_vaults=${allowedVaultIds.length}`);
  console.log(`[tab-service] public key at /.well-known/agent-tab.json`);
});

const sweep = (app as unknown as { sweep: () => Promise<void> }).sweep;
setInterval(() => void sweep(), 30_000).unref();
