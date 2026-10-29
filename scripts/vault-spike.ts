/**
 * Agent Tab — PayPal Vault v3 sandbox spike (Gate G1).
 *
 * Proves the one thing the whole idea depends on: a payment method vaulted once can be
 * charged later by the merchant (no buyer present), more than once, in the sandbox.
 *
 * Steps:
 *   npm run spike:setup                       -> creates a setup token, prints the approval URL
 *   (open the URL logged in as your SANDBOX buyer, approve, come back)
 *   npm run spike:token  -- <setup_token_id>  -> exchanges it for a payment token (vault_id)
 *   npm run spike:charge -- <vault_id> 1.00   -> creates + captures an order using the vault_id
 *   npm run spike:charge -- <vault_id> 2.50   -> second capture from the same token = G1 passed
 *   npm run spike:status -- <vault_id>        -> shows the stored payment token
 *
 * Every raw response is appended to .spike/log.jsonl so docs/ARCHITECTURE.md can quote it.
 * Only sandbox credentials are read; PAYPAL_ENV must be "sandbox".
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";

const BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
const RETURN_URL = process.env.SPIKE_RETURN_URL ?? "https://example.com/agent-tab/return";
const CANCEL_URL = process.env.SPIKE_CANCEL_URL ?? "https://example.com/agent-tab/cancel";

if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox" || !BASE.includes("sandbox")) {
  fail("Refusing to run: this spike only talks to the PayPal sandbox.");
}
if (!CLIENT_ID || !CLIENT_SECRET) {
  fail("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (sandbox app credentials).");
}

mkdirSync(".spike", { recursive: true });

type Json = Record<string, unknown>;

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function log(step: string, data: unknown) {
  appendFileSync(".spike/log.jsonl", JSON.stringify({ at: new Date().toISOString(), step, data }) + "\n");
}

async function accessToken(): Promise<string> {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as Json;
  if (!res.ok) {
    log("oauth.error", body);
    fail(`OAuth failed (${res.status}): ${JSON.stringify(body)}`);
  }
  log("oauth.ok", { scope: body.scope, expires_in: body.expires_in });
  return body.access_token as string;
}

async function pp(method: "GET" | "POST", path: string, token: string, body?: Json): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(), // idempotency: safe to retry the same logical call
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as Json;
  log(`${method} ${path}`, { status: res.status, json });
  return { status: res.status, json };
}

function linkRel(json: Json, rel: string): string | undefined {
  const links = (json.links as Array<{ rel: string; href: string }> | undefined) ?? [];
  return links.find((l) => l.rel === rel)?.href;
}

// ---------------------------------------------------------------- steps

async function setup() {
  const token = await accessToken();
  // Vault a PayPal wallet for merchant-initiated use. usage_type MERCHANT = we charge later
  // without the buyer present. customer_type CONSUMER is the default buyer persona.
  const { status, json } = await pp("POST", "/v3/vault/setup-tokens", token, {
    payment_source: {
      paypal: {
        description: "Agent Tab — metered tab for AI agent purchases",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        usage_pattern: "IMMEDIATE",
        permit_multiple_payment_tokens: false,
        experience_context: {
          brand_name: "Agent Tab (sandbox)",
          locale: "en-US",
          return_url: RETURN_URL,
          cancel_url: CANCEL_URL,
          shipping_preference: "NO_SHIPPING",
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
        },
      },
    },
  });
  if (status !== 200 && status !== 201) fail(`setup-token failed (${status}): ${JSON.stringify(json)}`);

  const approve = linkRel(json, "approve");
  console.log("\n✔ Setup token created");
  console.log(`  id:      ${json.id}`);
  console.log(`  status:  ${json.status}`);
  console.log(`\n→ Open this URL in a browser logged in as your SANDBOX buyer and approve:\n  ${approve}`);
  console.log(`\nThen run:  npm run spike:token -- ${json.id}`);
}

async function tokenFromSetup(setupTokenId: string) {
  const token = await accessToken();
  const { status, json } = await pp("POST", "/v3/vault/payment-tokens", token, {
    payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } },
  });
  if (status !== 200 && status !== 201) {
    fail(`payment-token failed (${status}). If the buyer has not approved yet, approve first. ${JSON.stringify(json)}`);
  }
  console.log("\n✔ Payment token (vault_id) created");
  console.log(`  vault_id:    ${json.id}`);
  console.log(`  customer_id: ${(json.customer as Json | undefined)?.id ?? "-"}`);
  console.log(`\nStore vault_id safely. Then run:  npm run spike:charge -- ${json.id} 1.00`);
}

async function charge(vaultId: string, amount: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) fail("Amount must look like 1.00");
  const token = await accessToken();

  // One order per SETTLEMENT (not per call) — this is the tab being closed out.
  const created = await pp("POST", "/v2/checkout/orders", token, {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: `tab-settlement-${Date.now()}`,
        description: "Agent Tab settlement (sandbox spike)",
        amount: { currency_code: "USD", value: amount },
      },
    ],
    payment_source: {
      paypal: {
        vault_id: vaultId,
        // Merchant-initiated, buyer not present:
        stored_credential: {
          payment_initiator: "MERCHANT",
          payment_type: "UNSCHEDULED",
          usage: "SUBSEQUENT",
        },
      },
    },
  });
  if (created.status !== 200 && created.status !== 201) {
    fail(`order create failed (${created.status}): ${JSON.stringify(created.json)}`);
  }
  console.log(`\n✔ Order created: ${created.json.id} (status ${created.json.status})`);

  // With a vault_id PayPal may complete the order immediately; otherwise capture explicitly.
  let final = created.json;
  if (created.json.status !== "COMPLETED") {
    const cap = await pp("POST", `/v2/checkout/orders/${created.json.id}/capture`, token, {});
    if (cap.status !== 200 && cap.status !== 201) fail(`capture failed (${cap.status}): ${JSON.stringify(cap.json)}`);
    final = cap.json;
  }

  const pu = (final.purchase_units as Json[] | undefined)?.[0];
  const captures = ((pu?.payments as Json | undefined)?.captures as Json[] | undefined) ?? [];
  const capture = captures[0];
  console.log(`✔ Order status: ${final.status}`);
  if (capture) {
    const amt = capture.amount as Json | undefined;
    console.log(`✔ Capture id:  ${capture.id}  ${amt?.value} ${amt?.currency_code}  (${capture.status})`);
    const fee = ((capture.seller_receivable_breakdown as Json | undefined)?.paypal_fee as Json | undefined);
    if (fee) console.log(`  PayPal fee:  ${fee.value} ${fee.currency_code}  <- feed this into the treasurer's constants`);
  } else {
    console.log("  (no capture object in response; inspect .spike/log.jsonl)");
  }
  console.log("\nRun this again with a different amount. Two successful captures from the same vault_id = Gate G1 passed.");
}

async function status(vaultId: string) {
  const token = await accessToken();
  const { status, json } = await pp("GET", `/v3/vault/payment-tokens/${vaultId}`, token);
  if (status !== 200) fail(`lookup failed (${status}): ${JSON.stringify(json)}`);
  console.log(JSON.stringify(json, null, 2));
}

// ---------------------------------------------------------------- cli

const [cmd, a1, a2] = process.argv.slice(2);
switch (cmd) {
  case "setup":
    await setup();
    break;
  case "token":
    if (!a1) fail("usage: spike:token -- <setup_token_id>");
    await tokenFromSetup(a1);
    break;
  case "charge":
    if (!a1) fail("usage: spike:charge -- <vault_id> <amount>");
    await charge(a1, a2 ?? "1.00");
    break;
  case "status":
    if (!a1) fail("usage: spike:status -- <vault_id>");
    await status(a1);
    break;
  default:
    fail("usage: vault-spike.ts <setup|token|charge|status> [...args]");
}
