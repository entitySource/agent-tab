# Agent Tab

**A bar tab for AI agents, settled through PayPal.**

Any API or MCP tool can charge AI agents in dollars. The agent runs a metered tab against a
vaulted PayPal payment method under hard limits (per-call cap, session cap, merchant
allowlist, human approval threshold). An AI treasurer decides *when* to settle the tab with a
single PayPal capture, so nobody loses money to per-transaction fees.

Built for the PayPal AI Hackathon 2026 (submission window Oct 1 - Nov 12, 2026).

## Status

- M1 core protocol: done (402 -> policy -> signed receipt -> data; approvals; replay/tamper rejection).
- M2 settlement + treasurer: done against a mock gateway; the PayPal Vault v3 gateway is wired and switches on when `PAYPAL_*` are set in `.env`.
- MCP tool: `@agent-tab/mcp` exposes `paid_fetch` and `tab_status`.
- M3 ledger UI: Vite + React + AG Grid + AG Charts with a live approval inbox (`npm run dev:ledger`, http://localhost:4300).
- M4 research agent: Claude plans and pays per call through the tab (`npm run dev:agent -- "your question"`); runs scripted without an API key.
- Gate G1 (real sandbox capture) pending credentials. See `../AGENT-TAB-PLAN.md`.

## Run the stack locally

```bash
npm run dev:tab      # tab service on :4100 (mock gateway until PAYPAL_* are set)
npm run dev:api      # demo paid API on :4200
```

Create a tab (the human step), then point an agent or the MCP tool at it:

```bash
curl -s -X POST localhost:4100/tabs -H 'content-type: application/json' -d '{"policy":{"per_call_cap":0.3,"session_cap":5,"daily_cap":20,"merchant_allowlist":["research-data-demo"],"approval_threshold":0.2,"settlement_threshold":1,"max_calls_per_minute":60,"expires_at":"2026-12-31T00:00:00Z"}}'
```

## Layout

```
packages/shared          zod schemas, policy types, Ed25519 receipt signing
packages/client          @agent-tab/client: fetch wrapper + fail-closed policy engine
packages/server          @agent-tab/server: 402 middleware for Express
packages/mcp             @agent-tab/mcp: MCP tool exposing the client
apps/tab-service         tabs, policies, ledger, AI treasurer, PayPal Vault + settlement
apps/paid-data-api       demo seller: research dataset behind 402
apps/research-agent      demo buyer: writes a report using paid calls
apps/ledger              Next.js + AG Grid ledger and approval inbox
scripts/vault-spike.ts   day-1 sandbox spike: setup-token -> payment-token -> capture
```

## Quick start (Vault spike, Gate G1)

```bash
npm install
cp .env.example .env        # fill PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
npm run spike:setup         # prints an approval URL; open it logged in as your sandbox buyer
npm run spike:token -- <setup_token_id>
npm run spike:charge -- <payment_token_id> 1.00
npm run spike:charge -- <payment_token_id> 2.50   # second capture from the same token = G1 passed
npm run spike:status -- <payment_token_id>
```

Sandbox prerequisites: in the Developer Dashboard create a **US** sandbox business app and tick
**Vault** and **Transaction Search** under Advanced options; create a US sandbox personal buyer.

## License

Apache-2.0. See `LICENSE`.
