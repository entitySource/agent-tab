# Agent Tab

**A bar tab for AI agents, settled through PayPal.**

Any API or MCP tool can charge AI agents in dollars. The agent runs a metered tab against a
PayPal payment method vaulted once by its owner, under hard limits the agent can never change:
per-call cap, session cap, daily cap, merchant allowlist, rate limit, and a threshold above
which a human must approve. An **AI treasurer** decides *when* to close the tab with a single
PayPal capture, so nobody loses money to the fixed per-transaction fee, and explains each
decision in one line.

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). Apache-2.0.

## Why

- Give an agent your PayPal credentials and it can spend without limit and without an audit trail.
  PayPal's own Agent Toolkit has open issues asking for a spend bound and a human gate.
- Charge an agent per API call and you lose money: PayPal's fixed fee (about $0.49) is 25x a
  2-cent call. Crypto rails (x402) solve metering but most businesses cannot hold stablecoins.
- Agent Tab fixes both with one PayPal primitive used the way it was designed: **Vault v3**
  (vault once, merchant-initiated capture later) plus a tab, a policy engine and a treasurer.

## How it works

```
Agent ──GET /v1/data──► Seller API            402 + quote {price, merchant_id, quote_id}
Agent ──POST /tabs/:id/lines {quote}──► Tab service
          policy check (caps, allowlist, rate) ─► 403 reason │ 202 needs human │ 201 signed receipt
Agent ──GET /v1/data  Authorization: Tab <receipt>──► Seller API verifies Ed25519 receipt, serves
Tab service ── treasurer after every line: hold / settle ──► PayPal Orders v2 capture via vault_id
Ledger UI ◄── SSE events: lines, blocks, approvals, treasurer rationale, settlements
```

The agent never holds a payment credential. It holds short-lived, single-use receipts. Policy is
enforced in the tab service, outside the model, so prompt injection cannot raise a limit. The
LLM treasurer can only move a settlement *earlier*; the deterministic rule always wins.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Packages and apps

| Path | What it is |
|---|---|
| `packages/shared` | zod schemas (Quote, Policy, TabLine, Receipt), Ed25519 receipt signing, the fail-closed policy engine |
| `packages/server` | `@agent-tab/server`: Express middleware `requirePayment({ price })` that answers 402 and verifies receipts |
| `packages/client` | `@agent-tab/client`: `createTabClient()` returns a `fetch` that handles 402 → tab → retry, and waits for human approval |
| `packages/mcp` | `@agent-tab/mcp`: MCP server exposing `paid_fetch` and `tab_status` to any agent runtime |
| `apps/tab-service` | Tabs, policies, lines, approvals, treasurer, PayPal gateway, settlements, metrics, SSE |
| `apps/paid-data-api` | Demo seller: a small research dataset behind four price points ($0.05, $0.10, $0.25, $9.00) |
| `apps/research-agent` | Demo buyer: Claude researches a question paying per call; scripted mode needs no API key |
| `apps/ledger` | Vite + React + AG Grid + AG Charts ledger with approval inbox and live feed |
| `scripts/vault-spike.ts` | Sandbox spike: setup-token → payment-token → two merchant-initiated captures |

## Quick start (5 minutes, no PayPal account needed)

Requirements: Node 20+, npm 10+.

```bash
git clone <this repo> && cd agent-tab
npm install
cp .env.example .env
```

Run the three services in three terminals:

```bash
npm run dev:tab       # tab service   http://localhost:4100  (mock gateway until PAYPAL_* are set)
npm run dev:api       # demo seller   http://localhost:4200
npm run dev:ledger    # ledger UI     http://localhost:4300
```

Open the ledger, click **Create tab** (defaults: $0.30 per call, $5 per session, ask above $0.20,
settle every $1), and copy the `TAB_ID` and `TAB_TOKEN` it shows once. Those go to the agent.
The ledger keeps a separate **owner token**: only it can approve, deny or watch the tab. Then run the agent:

```bash
TAB_ID=tab_... TAB_TOKEN=... npm run dev:agent -- "Why does per-call billing lose money for agentic commerce?"
```

What you will see, in order:

1. Calls metered on the tab at $0.05 and $0.10; the treasurer logs why it is holding.
2. The $0.25 summary stops in the **Approval inbox**. Click Approve; the agent resumes.
3. The agent tries the $9.00 export and is **blocked** (`over_per_call_cap`).
4. The agent closes the tab: **one capture** for the whole balance, with a capture id and fee.
5. The fee card shows what per-call billing would have cost versus the tab.

Without `TAB_ID`/`TAB_TOKEN` the agent creates its own tab with the demo policy. Set
`ANTHROPIC_API_KEY` to let Claude plan the research itself; otherwise a scripted plan runs.
Reports land in `apps/research-agent/reports/`.

## Real PayPal sandbox (Gate G1)

1. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) create a **US**
   sandbox business app. Under *Advanced options* tick **Vault** and **Transaction Search**.
   Create a US sandbox *personal* account as the buyer.
2. Put `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env`. The tab service switches from
   the mock gateway to PayPal automatically.
3. Vault a payment method once (the buyer step):

```bash
npm run spike:setup                         # prints an approval URL; open it as the sandbox buyer
npm run spike:token  -- <setup_token_id>    # exchanges it for a vault_id
npm run spike:charge -- <vault_id> 1.00     # merchant-initiated capture, no buyer present
npm run spike:charge -- <vault_id> 2.50     # second capture from the same vault_id = G1 passed
```

4. Put that `vault_id` in `.env` as `VAULT_IDS` (comma-separated if you have several) and restart
   the tab service. Tabs created with "Charge the PayPal sandbox vault linked to this deployment"
   (the agent does this by default) now settle with real sandbox orders. The tab service never
   accepts a vault id from a client, only from this list.

Raw responses from each step are appended to `.spike/log.jsonl`.

## Use it from your own agent

**Any HTTP client (TypeScript):**

```ts
import { createTabClient } from "@agent-tab/client";
const paidFetch = createTabClient({ tabServiceUrl, tabId, tabToken });
const res = await paidFetch("https://seller.example/v1/thing");   // 402 handled for you
```

**MCP (Claude Desktop, Cursor, custom harnesses):**

```json
{ "mcpServers": { "agent-tab": { "command": "node", "args": ["packages/mcp/dist/index.js"],
  "env": { "TAB_SERVICE_URL": "http://localhost:4100", "TAB_ID": "tab_...", "TAB_TOKEN": "..." } } } }
```

**Charge agents from your API (Express):**

```ts
import { requirePayment } from "@agent-tab/server";
app.get("/v1/thing", requirePayment({ price: 0.05, merchantId: "my-api", publicKeyJwk }), handler);
```

The seller fetches `publicKeyJwk` once from the tab service at `/.well-known/agent-tab.json`.

## Tab service API

| Method | Path | Purpose |
|---|---|---|
| POST | `/tabs` | Create a tab from a policy (+ `use_linked_vault`); returns the agent's `tab_token` and the human's `owner_token`, once |
| GET | `/tabs/:id` | State: policy, spent, outstanding, lines, blocked, settlements |
| POST | `/tabs/:id/lines` | Add a quoted call: 201 receipt, 202 approval pending, 403 denied with reason |
| GET | `/tabs/:id/metrics` | Calls, settlements, per-call vs tab fees, saved, blocked, approvals |
| POST | `/tabs/:id/close` | End the session; the treasurer settles whatever is outstanding |
| POST | `/tabs/:id/evaluate` | Force a treasurer evaluation |
| GET | `/tabs/:id/approvals` | Pending approvals for this tab (owner) |
| GET | `/approvals/:id` | Poll one approval (agent or owner of that tab) |
| POST | `/approvals/:id/approve` · `/deny` | Human decision (owner only) |
| GET | `/tabs/:id/events?token=` | Server-sent events for one tab (owner only) |
| GET | `/.well-known/agent-tab.json` | Receipt public key |

Tab routes take `Authorization: Bearer <token>`. The agent's `tab_token` can add lines, read and close;
the human's `owner_token` can also approve, deny and watch events. Sellers receive `Authorization: Tab <receipt>`.

## Policy fields

`per_call_cap`, `session_cap`, `daily_cap`, `merchant_allowlist[]`, `approval_threshold`,
`settlement_threshold`, `max_calls_per_minute`, `expires_at`. All checks fail closed.

## Tests

```bash
npm test          # 48 tests: policy engine, receipts, 402 protocol e2e, settlement, treasurer, auth, agent
npm run build     # type-check and build all Node workspaces
npm run build:ledger
```

Adversarial cases covered: over per-call cap, merchant not allowlisted, session cap mid-run,
tampered receipt, replayed receipt, a cheap route's receipt used on an expensive route, concurrent
lines racing to settle, approving without the owner token, a double-clicked approval, reading another
tab's events, an unlisted vault id, prompt-injected "raise my cap" (policy lives outside the LLM),
LLM asking to skip a due settlement, declined capture → tab delinquent → further lines blocked.

## Deploy (Render)

`render.yaml` is a Blueprint for three services: the tab service, the demo seller, and the static
ledger. In Render: *New + → Blueprint*, select the repo, then set the `sync: false` secrets
(`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `VAULT_IDS`, optional `ANTHROPIC_API_KEY`, and a fixed
`RECEIPT_*_JWK` pair so receipts survive restarts). Free services sleep when idle; the first request
after that takes about a minute, and in-memory tabs are cleared. Generate a keypair with:

```bash
node -e "const j=require('jose');j.generateKeyPair('EdDSA',{crv:'Ed25519',extractable:true}).then(async k=>{console.log('RECEIPT_PRIVATE_KEY_JWK='+JSON.stringify(await j.exportJWK(k.privateKey)));console.log('RECEIPT_PUBLIC_KEY_JWK='+JSON.stringify(await j.exportJWK(k.publicKey)))})"
```

## Sponsor tools used

- **AG Grid** and **AG Charts** for the ledger tables and the fee comparison chart.
- **Render** for hosting all three services from one Blueprint.
- **Postman**: import the tab service routes above to replay the protocol by hand.

## Limits and honesty

- The store is in memory; restart clears tabs. A Prisma seam exists in `apps/tab-service/src/store.ts`.
- Fee constants default to the published US commercial rate; the gateway records the real fee from
  every capture response so the comparison uses observed values once PayPal is connected.
- Live use of Vault requires PayPal approval; this project targets the sandbox.

See `docs/` for the demo script and the submission checklist.
