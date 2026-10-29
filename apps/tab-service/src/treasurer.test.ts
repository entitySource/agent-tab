import { describe, it, expect } from "vitest";
import { decide, decideCore, feeComparison, feeFor, type TreasurerInput } from "./treasurer.js";

const now = new Date("2026-11-04T10:00:00Z");
const base: TreasurerInput = {
  outstanding: 1.2, settlement_threshold: 5, session_ended: false,
  open_since: new Date(now.getTime() - 5 * 60_000), now, exposure_window_ms: 30 * 60_000, calls_last_minute: 3,
};

describe("fee model", () => {
  it("fixed fee dominates small amounts", () => {
    expect(feeFor(0.02)).toBe(0.49);
    expect(feeFor(10)).toBe(0.84);
  });
  it("per-call billing would lose money; the tab does not", () => {
    const prices = Array.from({ length: 40 }, () => 0.05);
    const cmp = feeComparison(prices, [1.0, 1.0]);
    expect(cmp.usage).toBe(2);
    expect(cmp.naive_fees).toBe(19.6);
    expect(cmp.tab_fees).toBe(1.04);
    expect(cmp.saved).toBe(18.56);
  });
});

describe("deterministic core", () => {
  it("holds below threshold", () => expect(decideCore(base)).toEqual({ settle: false, reason: "below_threshold" }));
  it("settles at threshold", () => expect(decideCore({ ...base, outstanding: 5 }).reason).toBe("threshold_reached"));
  it("settles at session end", () => expect(decideCore({ ...base, session_ended: true }).reason).toBe("session_end"));
  it("settles when the exposure window passes", () => expect(decideCore({ ...base, open_since: new Date(now.getTime() - 31 * 60_000) }).reason).toBe("exposure_window"));
  it("never settles nothing", () => expect(decideCore({ ...base, outstanding: 0, session_ended: true }).settle).toBe(false));
});

describe("LLM boundary", () => {
  it("advisor may pull a hold forward to an early settlement", async () => {
    const d = await decide(base, undefined, async () => ({ settle_early: true, rationale: "Burst of 40 calls in a minute; settle to cap exposure." }));
    expect(d.settle).toBe(true);
    expect(d.llm_adjusted).toBe(true);
    expect(d.rationale.startsWith("early:")).toBe(true);
  });
  it("advisor cannot settle when nothing is owed", async () => {
    const d = await decide({ ...base, outstanding: 0 }, undefined, async () => ({ settle_early: true, rationale: "x" }));
    expect(d.settle).toBe(false);
  });
  it("advisor is not consulted when the core already settles", async () => {
    let called = false;
    const d = await decide({ ...base, outstanding: 9 }, undefined, async () => { called = true; return { settle_early: false, rationale: "" }; });
    expect(d.settle).toBe(true);
    expect(called).toBe(false);
  });
  it("advisor failure falls back to the template rationale", async () => {
    const d = await decide(base, undefined, async () => { throw new Error("llm down"); });
    expect(d.settle).toBe(false);
    expect(d.rationale).toContain("holding");
  });
});
