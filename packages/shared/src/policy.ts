import type { Policy, Quote } from "./schemas.js";

export type TabState = {
  spent_session: number;
  spent_today: number;
  calls_last_minute: number;
  now: Date;
};

export type Decision =
  | { allow: true; needs_approval: boolean }
  | { allow: false; reason: string };

/**
 * Pure, fail-closed policy check. Any missing or malformed input denies.
 * The LLM never sees or edits this; it lives outside the model boundary on purpose.
 */
export function evaluate(quote: Quote, policy: Policy, state: TabState): Decision {
  if (!Number.isFinite(quote.price) || quote.price <= 0) return { allow: false, reason: "invalid_price" };
  if (new Date(quote.expires_at) <= state.now) return { allow: false, reason: "quote_expired" };
  if (new Date(policy.expires_at) <= state.now) return { allow: false, reason: "policy_expired" };
  if (!policy.merchant_allowlist.includes(quote.merchant_id)) return { allow: false, reason: "merchant_not_allowed" };
  if (quote.price > policy.per_call_cap) return { allow: false, reason: "over_per_call_cap" };
  if (state.spent_session + quote.price > policy.session_cap) return { allow: false, reason: "over_session_cap" };
  if (state.spent_today + quote.price > policy.daily_cap) return { allow: false, reason: "over_daily_cap" };
  if (state.calls_last_minute >= policy.max_calls_per_minute) return { allow: false, reason: "rate_limited" };
  return { allow: true, needs_approval: quote.price > policy.approval_threshold };
}
