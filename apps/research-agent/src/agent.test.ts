import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp as createTabApp, loadOrCreateKeys } from "../../tab-service/src/app.js";
import { createApp as createSellerApp } from "../../paid-data-api/src/app.js";
import { createTabClient } from "@agent-tab/client";
import { makeTools, runScripted, type Step } from "./agent.js";

let tabUrl = "", apiUrl = "";
const listen = (s: ReturnType<typeof createServer>) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  const keys = await loadOrCreateKeys();
  tabUrl = await listen(createServer(createTabApp(keys)));
  apiUrl = await listen(createServer(createSellerApp(keys.publicJwk, "research-data-demo")));
});

describe("research agent (scripted mode)", () => {
  it("produces a sourced report, gets blocked on the export, and settles on close", async () => {
    const policy = {
      per_call_cap: 0.3, session_cap: 5, daily_cap: 20, merchant_allowlist: ["research-data-demo"],
      approval_threshold: 0.2, settlement_threshold: 1, max_calls_per_minute: 60, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const tab = (await fetch(`${tabUrl}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy }) }).then((r) => r.json())) as { tab_id: string; tab_token: string; owner_token: string };
    const auth = { authorization: `Bearer ${tab.tab_token}` };

    const steps: Step[] = [];
    const paidFetch = createTabClient({
      tabServiceUrl: tabUrl, tabId: tab.tab_id, tabToken: tab.tab_token, approvalPollMs: 20,
      // stand in for the human in the ledger inbox
      onApprovalNeeded: ({ approval_id }) => void fetch(`${tabUrl}/approvals/${approval_id}/approve`, { method: "POST", headers: { authorization: `Bearer ${tab.owner_token}` } }),
    });
    const result = await runScripted("Why does per-call billing lose money for agentic commerce?", makeTools(paidFetch, apiUrl, steps), steps);

    expect(result.report).toContain("## Sources");
    expect(result.report).toContain("blocked by the spending policy (over_per_call_cap)");
    expect(steps.filter((s) => s.outcome === "ok").length).toBeGreaterThanOrEqual(5);
    expect(steps.find((s) => s.tool === "export_dataset")?.outcome).toBe("denied");
    expect(steps.find((s) => s.tool === "get_summary")?.outcome).toBe("ok"); // went through approval

    const closed = (await fetch(`${tabUrl}/tabs/${tab.tab_id}/close`, { method: "POST", headers: auth }).then((r) => r.json())) as { outstanding: number };
    expect(closed.outstanding).toBe(0);
    const m = (await fetch(`${tabUrl}/tabs/${tab.tab_id}/metrics`, { headers: auth }).then((r) => r.json())) as { calls: number; settlements: number; blocked: number; approvals: number; saved: number };
    expect(m.calls).toBeGreaterThanOrEqual(5);
    expect(m.settlements).toBeGreaterThanOrEqual(1);
    expect(m.blocked).toBe(1);
    expect(m.approvals).toBe(1);
    expect(m.saved).toBeGreaterThan(0);
  });
});
