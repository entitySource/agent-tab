# Architecture

## Components

```
┌──────────────┐  402 + quote   ┌──────────────────┐
│ Agent        │◄──────────────►│ Seller API       │  @agent-tab/server (requirePayment)
│ @agent-tab/  │ retry + receipt│ apps/paid-data-  │
│ client / mcp │                │ api              │
└──────┬───────┘                └────────┬─────────┘
       │ POST /tabs/:id/lines            │ usage (onUsage)
       ▼                                 ▼
┌────────────────────────────────────────────────┐      ┌──────────────────────┐
│ Tab service (apps/tab-service)                 │      │ PayPal sandbox       │
│  store.ts      tabs, lines, blocked, settlements│ Vault│  /v3/vault/*         │
│  app.ts        routes, policy, receipts, SSE   │ v3   │  /v2/checkout/orders │
│  treasurer.ts  deterministic core + fee model  │─────►│  capture             │
│  advisor.ts    optional LLM (settle early only) │      └──────────────────────┘
│  gateway.ts    PaymentGateway: mock | paypal   │
└──────────────────────┬─────────────────────────┘
                       │ GET /events (SSE)
                       ▼
               ┌──────────────┐
               │ Ledger UI    │  apps/ledger (Vite, React, AG Grid, AG Charts)
               └──────────────┘
```

## Protocol

1. **Quote.** Seller middleware answers an unauthenticated request with `402` and a one-time
   quote: `{quote_id, merchant_id, price, currency, resource, expires_at}`. Quotes expire in
   5 minutes and are single-use.
2. **Line.** The client posts the quote to `POST /tabs/:id/lines` with the tab token. The tab
   service runs the policy engine (`packages/shared/src/policy.ts`): price validity, quote and
   policy expiry, merchant allowlist, per-call cap, session cap, daily cap, rate limit. Any
   failure is a `403 {reason}` and is recorded as a blocked attempt. A price above
   `approval_threshold` becomes a pending approval (`202`); the client polls until a human
   decides. Otherwise the line is appended and a **receipt** is signed.
3. **Receipt.** An Ed25519 JWT (`jose`) with claims `{line_id, tab_id, quote_id, merchant_id,
   price, nonce}` and a 120-second lifetime. The seller verifies the signature against the
   tab service's public key (`/.well-known/agent-tab.json`), checks merchant and price against
   its own quote, and rejects replays by nonce.
4. **Treasurer.** After every line (and on a 30-second sweep) the tab service evaluates:
   settle if `outstanding >= settlement_threshold`, if the session ended, or if the balance
   has been open longer than the exposure window; otherwise hold. If an LLM advisor is
   configured and the core says hold, the LLM may recommend settling early with a reason; it
   can never delay a due settlement or touch policy. Every decision is emitted with a rationale.
5. **Settlement.** One `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` and
   `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}`, captured if not auto-completed.
   `PayPal-Request-Id` is derived from `tab_id:n`, so retrying a settlement is idempotent.
   The capture id and PayPal fee are stored on the settlement. A failed capture marks the tab
   delinquent and blocks further lines.

## Trust boundaries

| Holder | Has | Does not have |
|---|---|---|
| Human | Policy, PayPal login, approval inbox | Nothing to do per call |
| Agent | Tab token, short-lived receipts | Vault id, PayPal credentials, policy write access |
| Seller | Tab service public key | Buyer identity, payment method |
| Tab service | Vault id, PayPal client credentials, private key | The agent's prompts or tools |

## Fee model

`fee(amount) = fixed + percent * amount` with defaults 0.49 + 3.49% (US commercial). Observed
fees from capture responses are recorded per settlement and shown in the ledger. The metrics
endpoint compares `sum(fee(price_i))` (per-call billing) with `sum(fee(settlement_j))` (the tab).

## Sandbox notes (fill in from `.spike/log.jsonl` after Gate G1)

- Setup-token request/response:
- Payment-token (vault_id) response:
- Order + capture response, including `seller_receivable_breakdown.paypal_fee`:
- Observed token lifetime and any scopes required:
