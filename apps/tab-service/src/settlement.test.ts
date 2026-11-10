import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createApp, loadOrCreateKeys } from "./app.js";
import { MemoryStore } from "./store.js";
import { MockGateway } from "./gateway.js";

let url = "";
let gateway: MockGateway;
const merchant = "research-data-demo";
const later = new Date(Date.now() + 3_600_000).toISOString();

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  gateway = new MockGateway();
  const srv = createServer(createApp(await loadOrCreateKeys(), new MemoryStore(), { gateway }));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const quote = (price: number) => ({ quote_id: randomUUID(), merchant_id: merchant, price, currency: "USD", resource: "/v1/x", expires_at: later });

async function openTab(threshold = 1) {
  const r = await fetch(`${url}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: {
    per_call_cap: 1, session_cap: 100, daily_cap: 100, merchant_allowlist: [merchant], approval_threshold: 5,
    settlement_threshold: threshold, max_calls_per_minute: 1000, expires_at: later } }) });
  const tab = (await r.json()) as { tab_id: string; tab_token: string };
  const h = { authorization: `Bearer ${tab.tab_token}`, "content-type": "application/json" };
  return {
    ...tab,
    line: (price: number) => fetch(`${url}/tabs/${tab.tab_id}/lines`, { method: "POST", headers: h, body: JSON.stringify({ quote: quote(price) }) }),
    state: () => fetch(`${url}/tabs/${tab.tab_id}`, { headers: h }).then((r) => r.json()) as Promise<{ outstanding: number; settlements: Array<{ status: string; amount: number; capture_id?: string; reason: string }>; delinquent: boolean }>,
    metrics: () => fetch(`${url}/tabs/${tab.tab_id}/metrics`, { headers: h }).then((r) => r.json()) as Promise<{ calls: number; settlements: number; naive_fees: number; tab_fees: number; saved: number }>,
    close: () => fetch(`${url}/tabs/${tab.tab_id}/close`, { method: "POST", headers: h }).then((r) => r.json()) as Promise<{ settlement: { status: string; reason: string } | null; outstanding: number }>,
  };
}

describe("settlement (Gate G3 shape)", () => {
  it("40 calls at $0.05 produce at most 3 captures and the ledger balances", async () => {
    const before = gateway.calls.length;
    const tab = await openTab(1);
    for (let i = 0; i < 40; i++) expect((await tab.line(0.05)).status).toBe(201);
    const closed = await tab.close();
    expect(closed.settlement).toBeNull(); // 40 x 0.05 = 2.00 settled exactly at the two thresholds
    expect(closed.outstanding).toBe(0);

    const s = await tab.state();
    const done = s.settlements.filter((x) => x.status === "completed");
    expect(done.length).toBeLessThanOrEqual(3);
    expect(done.every((x) => x.capture_id?.startsWith("MOCK-CAP-"))).toBe(true);
    expect(Math.round(done.reduce((a, x) => a + x.amount, 0) * 100) / 100).toBe(2);
    expect(gateway.calls.length - before).toBe(done.length);

    const m = await tab.metrics();
    expect(m.calls).toBe(40);
    expect(m.settlements).toBe(done.length);
    expect(m.saved).toBeGreaterThan(15);
  });

  it("closing settles a partial balance once", async () => {
    const tab = await openTab(1);
    for (let i = 0; i < 7; i++) expect((await tab.line(0.05)).status).toBe(201);
    const closed = await tab.close();
    expect(closed.settlement?.status).toBe("completed");
    expect(closed.settlement?.reason).toBe("session_end");
    expect(closed.outstanding).toBe(0);
  });

  it("a declined capture marks the tab delinquent and blocks further lines", async () => {
    const tab = await openTab(0.1);
    gateway.failNext = 1;
    expect((await tab.line(0.1)).status).toBe(201); // line accepted, settlement attempted and fails
    const s = await tab.state();
    expect(s.delinquent).toBe(true);
    expect(s.settlements[0].status).toBe("failed");
    const next = await tab.line(0.05);
    expect(next.status).toBe(403);
    expect(((await next.json()) as { reason: string }).reason).toBe("tab_delinquent");
  });

  it("closing a tab with nothing outstanding settles nothing and ends the session", async () => {
    const tab = await openTab(1);
    const closed = await tab.close();
    expect(closed.settlement).toBeNull();
    expect((await tab.line(0.05)).status).toBe(403);
  });

  it("fix 2: concurrent lines never settle the same balance twice", async () => {
    const tab = await openTab(0.1);
    const before = gateway.calls.length;
    gateway.delayMs = 40; // a slow PayPal makes the race window wide
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => tab.line(0.1)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      const s = await tab.state();
      const done = s.settlements.filter((x) => x.status === "completed");
      const settled = Math.round(done.reduce((a, x) => a + x.amount, 0) * 100) / 100;
      expect(settled).toBe(2); // 20 x $0.10, captured exactly once in total
      expect(s.outstanding).toBe(0);
      expect(done.every((x) => x.amount > 0)).toBe(true);
      expect(gateway.calls.length - before).toBe(done.length);
      const refs = gateway.calls.slice(before).map((c) => c.reference);
      expect(new Set(refs).size).toBe(refs.length); // every PayPal request id is unique
    } finally {
      gateway.delayMs = 0;
    }
  });
});
