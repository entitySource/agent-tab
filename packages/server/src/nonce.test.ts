import { describe, expect, it } from "vitest";
import { NonceStore } from "./index.js";

describe("NonceStore (fix 4: bounded replay memory)", () => {
  it("remembers a nonce until its receipt expires, then forgets it", () => {
    const s = new NonceStore();
    const t0 = 1_000_000;
    s.add("n1", t0 + 120_000, t0);
    expect(s.has("n1", t0 + 1)).toBe(true);
    expect(s.has("n1", t0 + 120_001)).toBe(false);
    s.add("n2", t0 + 300_000, t0 + 125_000); // triggers a sweep
    expect(s.size).toBe(1);
  });

  it("never grows past its cap", () => {
    const s = new NonceStore(100);
    const now = Date.now();
    for (let i = 0; i < 1_000; i++) s.add(`n${i}`, now + 60_000, now);
    expect(s.size).toBe(100);
    expect(s.has("n999", now)).toBe(true);
  });
});
