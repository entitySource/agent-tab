import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp as createTabApp, loadOrCreateKeys } from "../../tab-service/src/app.js";
import { createTabClient } from "@agent-tab/client";
import { createApp as createSellerApp } from "./app.js";

const MERCHANT = "research-data-demo";
let tabServer: Server, sellerServer: Server;
let tabUrl: string, sellerUrl: string;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  const keys = await loadOrCreateKeys();
  tabServer = createServer(createTabApp(keys));
  tabUrl = await listen(tabServer);
  sellerServer = createServer(createSellerApp(keys.publicJwk, MERCHANT));
  sellerUrl = await listen(sellerServer);
});
afterAll(() => { tabServer.close(); sellerServer.close(); });

async function openTab(policy: Record<string, unknown>) {
  const r = await fetch(`${tabUrl}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy }) });
  expect(r.status).toBe(201);
  return (await r.json()) as { tab_id: string; tab_token: string; owner_token: string };
}
const tabState = (tab: { tab_id: string; tab_token: string }) =>
  fetch(`${tabUrl}/tabs/${tab.tab_id}`, { headers: { authorization: `Bearer ${tab.tab_token}` } }).then((r) => r.json()) as Promise<{ spent_session: number; lines: unknown[]; blocked: Array<{ reason: string }> }>;

const basePolicy = {
  per_call_cap: 0.2, session_cap: 1, daily_cap: 5, merchant_allowlist: [MERCHANT],
  approval_threshold: 0.15, settlement_threshold: 0.5, max_calls_per_minute: 30,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

describe("402 -> tab -> receipt -> data", () => {
  it("serves paid data through the tab and records the line", async () => {
    const tab = await openTab(basePolicy);
    const paidFetch = createTabClient({ tabServiceUrl: tabUrl, tabId: tab.tab_id, tabToken: tab.tab_token });

    const res = await paidFetch(`${sellerUrl}/v1/search?q=webmcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results.length).toBeGreaterThan(0);

    const state = await tabState(tab);
    expect(state.spent_session).toBe(0.05);
    expect(state.lines).toHaveLength(1);
  });

  it("returns 402 with a quote when no receipt is presented", async () => {
    const r = await fetch(`${sellerUrl}/v1/docs/d1`);
    expect(r.status).toBe(402);
    const q = (await r.json()) as { quote: { price: number; merchant_id: string } };
    expect(q.quote.price).toBe(0.1);
    expect(q.quote.merchant_id).toBe(MERCHANT);
  });

  it("blocks a call over the per-call cap and records it", async () => {
    const tab = await openTab(basePolicy);
    const paidFetch = createTabClient({ tabServiceUrl: tabUrl, tabId: tab.tab_id, tabToken: tab.tab_token });
    await expect(paidFetch(`${sellerUrl}/v1/summary/x402`)).rejects.toMatchObject({ name: "TabDeniedError", reason: "over_per_call_cap" });
    const state = await tabState(tab);
    expect(state.blocked[0].reason).toBe("over_per_call_cap");
  });

  it("stops at the session cap", async () => {
    const tab = await openTab({ ...basePolicy, session_cap: 0.1, approval_threshold: 1 });
    const paidFetch = createTabClient({ tabServiceUrl: tabUrl, tabId: tab.tab_id, tabToken: tab.tab_token });
    expect((await paidFetch(`${sellerUrl}/v1/search?q=fee`)).status).toBe(200);
    expect((await paidFetch(`${sellerUrl}/v1/search?q=fee`)).status).toBe(200);
    await expect(paidFetch(`${sellerUrl}/v1/search?q=fee`)).rejects.toMatchObject({ reason: "over_session_cap" });
  });

  it("refuses a merchant that is not on the allowlist", async () => {
    const tab = await openTab({ ...basePolicy, merchant_allowlist: ["someone-else"] });
    const paidFetch = createTabClient({ tabServiceUrl: tabUrl, tabId: tab.tab_id, tabToken: tab.tab_token });
    await expect(paidFetch(`${sellerUrl}/v1/search?q=fee`)).rejects.toMatchObject({ reason: "merchant_not_allowed" });
  });

  it("rejects a replayed receipt", async () => {
    const tab = await openTab(basePolicy);
    const quote = ((await (await fetch(`${sellerUrl}/v1/search?q=hold`)).json()) as { quote: unknown }).quote;
    const line = (await fetch(`${tabUrl}/tabs/${tab.tab_id}/lines`, { method: "POST", headers: { authorization: `Bearer ${tab.tab_token}`, "content-type": "application/json" }, body: JSON.stringify({ quote }) }).then((r) => r.json())) as { receipt: string };
    const first = await fetch(`${sellerUrl}/v1/search?q=hold`, { headers: { authorization: `Tab ${line.receipt}` } });
    expect(first.status).toBe(200);
    const replay = await fetch(`${sellerUrl}/v1/search?q=hold`, { headers: { authorization: `Tab ${line.receipt}` } });
    expect([403, 409]).toContain(replay.status);
  });

  it("rejects a tampered receipt", async () => {
    const r = await fetch(`${sellerUrl}/v1/search?q=hold`, { headers: { authorization: "Tab eyJhbGciOiJFZERTQSJ9.e30.bad" } });
    expect(r.status).toBe(401);
  });

  it("routes an over-threshold call through human approval", async () => {
    const tab = await openTab({ ...basePolicy, per_call_cap: 0.3 }); // summary costs 0.25 > approval_threshold 0.15
    let approvalId = "";
    const paidFetch = createTabClient({
      tabServiceUrl: tabUrl, tabId: tab.tab_id, tabToken: tab.tab_token, approvalPollMs: 20,
      onApprovalNeeded: ({ approval_id }) => { approvalId = approval_id; },
    });
    const pending = paidFetch(`${sellerUrl}/v1/summary/merchant-pain`);
    for (let i = 0; i < 100 && !approvalId; i++) await new Promise((r) => setTimeout(r, 10));
    expect(approvalId).not.toBe("");
    const ok = await fetch(`${tabUrl}/approvals/${approvalId}/approve`, { method: "POST", headers: { authorization: `Bearer ${tab.owner_token}` } });
    expect(ok.status).toBe(200);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  it("fix 1: a receipt bought for a cheap route cannot unlock an expensive one", async () => {
    const tab = await openTab({ ...basePolicy, approval_threshold: 1 });
    const h = { authorization: `Bearer ${tab.tab_token}`, "content-type": "application/json" };
    const cheap = ((await (await fetch(`${sellerUrl}/v1/search?q=fee`)).json()) as { quote: unknown }).quote;
    const line = (await fetch(`${tabUrl}/tabs/${tab.tab_id}/lines`, { method: "POST", headers: h, body: JSON.stringify({ quote: cheap }) }).then((r) => r.json())) as { receipt: string };
    const receipt = { authorization: `Tab ${line.receipt}` };

    const expensive = await fetch(`${sellerUrl}/v1/export`, { headers: receipt });
    expect(expensive.status).toBe(403);
    expect(((await expensive.json()) as { error: string }).error).toBe("wrong_resource");
    const sibling = await fetch(`${sellerUrl}/v1/docs/d1`, { headers: receipt });
    expect(sibling.status).toBe(403);
    // The receipt still works where it was bought, exactly once.
    expect((await fetch(`${sellerUrl}/v1/search?q=fee`, { headers: receipt })).status).toBe(200);
    expect((await fetch(`${sellerUrl}/v1/search?q=fee`, { headers: receipt })).status).toBe(403);
  });

  it("fix 1: a quote is bound to its exact URL, query string included", async () => {
    const tab = await openTab({ ...basePolicy, approval_threshold: 1 });
    const h = { authorization: `Bearer ${tab.tab_token}`, "content-type": "application/json" };
    const quote = ((await (await fetch(`${sellerUrl}/v1/search?q=fee`)).json()) as { quote: unknown }).quote;
    const line = (await fetch(`${tabUrl}/tabs/${tab.tab_id}/lines`, { method: "POST", headers: h, body: JSON.stringify({ quote }) }).then((r) => r.json())) as { receipt: string };
    const other = await fetch(`${sellerUrl}/v1/search?q=everything`, { headers: { authorization: `Tab ${line.receipt}` } });
    expect(other.status).toBe(403);
  });
});
