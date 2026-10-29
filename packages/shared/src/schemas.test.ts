import { describe, it, expect } from "vitest";
import { Policy, Quote } from "./schemas.js";

describe("schemas", () => {
  it("rejects a quote with a non-positive price", () => {
    expect(() =>
      Quote.parse({ quote_id: "q", merchant_id: "m", price: 0, currency: "USD", resource: "/x", expires_at: new Date().toISOString() }),
    ).toThrow();
  });
  it("requires at least one allowlisted merchant", () => {
    expect(() =>
      Policy.parse({ per_call_cap: 1, session_cap: 10, daily_cap: 20, merchant_allowlist: [], approval_threshold: 0.5, settlement_threshold: 5, max_calls_per_minute: 30, expires_at: new Date().toISOString() }),
    ).toThrow();
  });
});
