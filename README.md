# Agent Tab

**A bar tab for AI agents, settled through PayPal.**

Any API or MCP tool can charge AI agents in dollars. The agent runs a metered tab against a
vaulted PayPal payment method under hard limits (per-call cap, session cap, merchant
allowlist, human approval threshold). An AI treasurer decides *when* to settle the tab with a
single PayPal capture, so nobody loses money to per-transaction fees.

Built for the PayPal AI Hackathon 2026 (submission window Oct 1 - Nov 12, 2026).

## Status

Day 1 scaffold. See `../AGENT-TAB-PLAN.md` for the build plan and gates.

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
