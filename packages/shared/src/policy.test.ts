import { describe, it, expect } from "vitest";
import { evaluate } from "./policy.js";
import type { Policy, Quote } from "./schemas.js";

const later = new Date(Date.now() + 60_000).toISOString();
const policy: Policy = {
  per_call_cap: 1, session_cap: 20, daily_cap: 50, merchant_allowlist: ["research-data-demo"],
  approval_threshold: 0.5, settlement_threshold: 5, max_calls_per_minute: 30, expires_at: later,
};
const quote = (over: Partial<Quote> = {}): Quote => ({
  quote_id: "q1", merchant_id: "research-data-demo", price: 0.1, currency: "USD", resource: "/v1/data/x", expires_at: later, ...over,
});
const state = { spent_session: 0, spent_today: 0, calls_last_minute: 0, now: new Date() };

describe("policy engine", () => {
  it("allows a small in-policy call without approval", () => {
    expect(evaluate(quote(), policy, state)).toEqual({ allow: true, needs_approval: false });
  });
  it("blocks over per-call cap", () => {
    expect(evaluate(quote({ price: 900 }), policy, state)).toEqual({ allow: false, reason: "over_per_call_cap" });
  });
  it("blocks merchant not on allowlist", () => {
    expect(evaluate(quote({ merchant_id: "other" }), policy, state)).toEqual({ allow: false, reason: "merchant_not_allowed" });
  });
  it("blocks when session cap would be exceeded", () => {
    expect(evaluate(quote({ price: 0.5 }), policy, { ...state, spent_session: 19.6 })).toEqual({ allow: false, reason: "over_session_cap" });
  });
  it("requires approval above threshold", () => {
    expect(evaluate(quote({ price: 0.75 }), policy, state)).toEqual({ allow: true, needs_approval: true });
  });
  it("blocks when rate limited", () => {
    expect(evaluate(quote(), policy, { ...state, calls_last_minute: 30 })).toEqual({ allow: false, reason: "rate_limited" });
  });
});
