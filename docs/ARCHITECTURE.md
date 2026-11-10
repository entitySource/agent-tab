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
| Human | Policy, owner token (approve, deny, watch events), PayPal login | Nothing to do per call |
| Agent | Tab token, short-lived receipts | Vault id, PayPal credentials, policy write access |
| Seller | Tab service public key | Buyer identity, payment method |
| Tab service | Vault ids from the operator's allowlist, PayPal client credentials, private key | The agent's prompts or tools |

## Hardening (Nov 10)

- **Quotes are bound to route and price.** A receipt is accepted only on the exact URL it was quoted
  for, and only if the receipt's price, the quote's price and the route's configured price all match.
  Before this, a receipt bought for a $0.05 route could unlock a $9 route on the same seller.
- **Settlements are serialised per tab.** Treasurer runs for one tab form a queue; each run re-reads
  the outstanding balance after the previous settlement is recorded. Concurrent lines can no longer
  capture the same balance twice, and every PayPal request id is unique.
- **Two credentials per tab.** The agent's `tab_token` cannot approve, deny or watch. The human's
  `owner_token` can. Events are streamed per tab to the owner only. Tokens are compared in constant time.
- **Vaults come only from the operator.** `VAULT_IDS` lists the vaults a deployment may charge; a
  client can opt in with `use_linked_vault` but can never name an arbitrary vault id.
- **Replay memory is bounded.** Seen receipt nonces are dropped once the receipt has expired (after
  which the signature check rejects it anyway), with a hard cap as a backstop. Outstanding quotes are
  capped the same way so unauthenticated 402 traffic cannot exhaust memory.

## Fee model

`fee(amount) = fixed + percent * amount` with defaults 0.49 + 3.49% (US commercial). Observed
fees from capture responses are recorded per settlement and shown in the ledger. The metrics
endpoint compares `sum(fee(price_i))` (per-call billing) with `sum(fee(settlement_j))` (the tab).

## Sandbox notes (Gate G1 passed 2026-10-29)

What it took to get a PayPal wallet vaulted and charged merchant-initiated in the sandbox:

- **Account country matters.** The auto-generated India (IN) sandbox business account never
  received Vault v3 scopes even with "Save payment methods" ticked; the token carried only the
  legacy `v1/vault/credit-card` scope and `POST /v3/vault/setup-tokens` returned
  `403 NOT_AUTHORIZED`. A new **US** sandbox business account plus a new app attached to it
  fixed it immediately: the token gained `services/vault/payment-tokens/readwrite`.
- **The buyer must be a different sandbox account from the seller.** Approving the setup token
  while logged in as the business account shows "You are logging into the account of the seller".
  A US sandbox *personal* account approved it; the consent screen is titled "One-time setup,
  faster checkouts" and lists the buyer's funding sources.
- **Flow that worked:** `POST /v3/vault/setup-tokens` (`usage_type: MERCHANT`, `customer_type:
  CONSUMER`, `usage_pattern: IMMEDIATE`, `payment_method_preference: IMMEDIATE_PAYMENT_REQUIRED`)
  → buyer opens the `approve` link → `POST /v3/vault/payment-tokens` with
  `{token: {id, type: "SETUP_TOKEN"}}` → `vault_id` (17 chars, e.g. `8aj93029j0199535u`).
- **Captures:** `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` and
  `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}` returned `status: COMPLETED` directly;
  no separate capture call was needed. Two captures from the same vault id succeeded with the
  buyer absent: `9NU79426JT338232M` ($1.00) and `4H564989KF0464627` ($2.50).
- **Observed fees** in `seller_receivable_breakdown.paypal_fee`: $0.52 on $1.00 and $0.58 on
  $2.50, which match `0.49 + 3.49%` to the cent. The treasurer's defaults stand.
- **Token lifetime:** client-credentials tokens report `expires_in` of about 32,000 s (~9 h).
  The gateway caches the token and refreshes a minute before expiry.
- Raw request/response bodies for every step are in `.spike/log.jsonl` (git-ignored).
