import "dotenv/config";
import { createApp, loadOrCreateKeys } from "./app.js";
import { MockGateway, PayPalGateway } from "./gateway.js";
import { createAnthropicAdvisor } from "./advisor.js";

const port = Number(process.env.TAB_SERVICE_PORT ?? 4100);
const keys = await loadOrCreateKeys();
const gateway = PayPalGateway.fromEnv() ?? new MockGateway();
const advisor = await createAnthropicAdvisor();

const app = createApp(keys, undefined, { gateway, advisor });
app.listen(port, () => {
  console.log(`[tab-service] listening on http://localhost:${port}`);
  console.log(`[tab-service] gateway=${gateway.name} advisor=${advisor ? "anthropic" : "template"}`);
  console.log(`[tab-service] public key at /.well-known/agent-tab.json`);
});

const sweep = (app as unknown as { sweep: () => Promise<void> }).sweep;
setInterval(() => void sweep(), 30_000).unref();
