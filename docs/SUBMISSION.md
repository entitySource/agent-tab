# Devpost submission

## Checklist

- [ ] Public GitHub repo, Apache-2.0 license visible in the About panel
- [ ] README with complete run instructions and sandbox test credentials (or how to create them)
- [ ] Hosted demo URL (Render ledger) + tab service URL
- [ ] Video under 3 minutes, public on YouTube, link in the form
- [ ] Description, tools list, "what was built during the hackathon window" filled in
- [ ] Submitted before Nov 12, 2026, 12:00 pm PT

## Project name

Agent Tab

## Tagline

A bar tab for AI agents, settled through PayPal.

## Description (draft)

**The problem.** AI agents are starting to pay for things, and the small purchases dominate:
API calls, data lookups, tool invocations. Today a developer has two bad options. Give the agent
full PayPal credentials, so it can spend without limit and without an audit trail. Or bill it per
call, which loses money because PayPal's fixed fee is roughly 25 times a 2-cent call. PayPal's own
Agent Toolkit has open issues asking for a spend bound and a human gate. Crypto rails solve
metering but most businesses cannot hold stablecoins.

**What Agent Tab does.** Any API or MCP tool can charge AI agents in dollars. The agent runs a
metered tab against a PayPal payment method that its owner vaulted once. A fail-closed policy
engine enforces per-call, session and daily caps, a merchant allowlist, a rate limit, and a
threshold above which a human must approve in an inbox. An AI treasurer decides when to close the
tab with a single PayPal capture, balancing the fixed fee against exposure, and explains each
decision. The LLM can only move a settlement earlier; the deterministic rule always wins.

**How PayPal is used.** Vault v3 setup tokens and payment tokens (vault once), Orders v2 with
`payment_source.paypal.vault_id` and merchant-initiated stored-credential flags, idempotent
`PayPal-Request-Id` per settlement, observed `paypal_fee` from every capture. Sandbox only.

**How AI is used.** Claude plans the research and pays per call through the tab via the Vercel
AI SDK; Claude also serves as the treasurer's advisor with a hard boundary. The MCP server lets
Claude Desktop or any agent runtime use a tab without seeing a credential.

**What the demo shows.** Eight metered calls, one human approval, one blocked $9 export, one
PayPal capture, and the fee comparison: $3.93 if billed per call versus $0.52 on the tab.

**What was built during the hackathon.** Everything: protocol, policy engine, receipts, tab
service, treasurer, PayPal gateway, MCP tool, ledger UI, research agent, 48 tests including security regressions, hosting.

## Tools

PayPal REST APIs (Vault v3, Orders v2, Webhooks), Claude via Vercel AI SDK, Model Context
Protocol SDK, AG Grid + AG Charts, Render, Express, Vite, React, zod, jose, Vitest.

## Testing instructions for judges

See README "Quick start". No PayPal account is needed to run the full loop with the mock
gateway. For real sandbox captures follow README "Real PayPal sandbox"; the repo's `.env.example`
lists every variable.
