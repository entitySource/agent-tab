import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createApp, loadOrCreateKeys, parseJwkEnv } from "./app.js";
import { MemoryStore } from "./store.js";
import { MockGateway } from "./gateway.js";

let url = "";
const merchant = "research-data-demo";
const later = () => new Date(Date.now() + 3_600_000).toISOString();
const LINKED = "8aj93029j0199535u";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  const app = createApp(await loadOrCreateKeys(), new MemoryStore(), { gateway: new MockGateway(), allowedVaultIds: [LINKED] });
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const policy = () => ({ per_call_cap: 1, session_cap: 10, daily_cap: 10, merchant_allowlist: [merchant], approval_threshold: 0.2, settlement_threshold: 5, max_calls_per_minute: 1000, expires_at: later() });
const quote = (price: number) => ({ quote_id: randomUUID(), merchant_id: merchant, price, currency: "USD", resource: "/v1/x", expires_at: later() });
const post = (path: string, body: unknown, token?: string) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

async function openTab(extra: Record<string, unknown> = {}) {
  const r = await post("/tabs", { policy: policy(), ...extra });
  return { status: r.status, body: (await r.json()) as { tab_id: string; tab_token: string; owner_token: string; vault_linked: boolean; error?: string } };
}
async function pendingApproval(tab: { tab_id: string; tab_token: string }) {
  const r = await post(`/tabs/${tab.tab_id}/lines`, { quote: quote(0.5) }, tab.tab_token);
  expect(r.status).toBe(202);
  return ((await r.json()) as { approval_id: string }).approval_id;
}

describe("fix 3: owner token", () => {
  it("issues separate agent and owner tokens", async () => {
    const { body } = await openTab();
    expect(body.tab_token).toBeTruthy();
    expect(body.owner_token).toBeTruthy();
    expect(body.owner_token).not.toBe(body.tab_token);
  });

  it("only the owner can approve; no token and the agent token are refused", async () => {
    const { body: tab } = await openTab();
    const id = await pendingApproval(tab);
    expect((await post(`/approvals/${id}/approve`, {})).status).toBe(401);
    expect((await post(`/approvals/${id}/approve`, {}, tab.tab_token)).status).toBe(403);
    const { body: other } = await openTab();
    expect((await post(`/approvals/${id}/approve`, {}, other.owner_token)).status).toBe(401);
    expect((await post(`/approvals/${id}/approve`, {}, tab.owner_token)).status).toBe(200);
  });

  it("a double click on approve adds the line once", async () => {
    const { body: tab } = await openTab();
    const id = await pendingApproval(tab);
    const [a, b] = await Promise.all([post(`/approvals/${id}/approve`, {}, tab.owner_token), post(`/approvals/${id}/approve`, {}, tab.owner_token)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const state = (await fetch(`${url}/tabs/${tab.tab_id}`, { headers: { authorization: `Bearer ${tab.owner_token}` } }).then((r) => r.json())) as { lines: unknown[] };
    expect(state.lines).toHaveLength(1);
  });

  it("the inbox is per tab and owner only; the global list is gone", async () => {
    const { body: a } = await openTab();
    const { body: b } = await openTab();
    await pendingApproval(a);
    await pendingApproval(b);
    const inboxA = (await fetch(`${url}/tabs/${a.tab_id}/approvals`, { headers: { authorization: `Bearer ${a.owner_token}` } }).then((r) => r.json())) as Array<{ tab_id: string }>;
    expect(inboxA.length).toBe(1);
    expect(inboxA[0].tab_id).toBe(a.tab_id);
    expect((await fetch(`${url}/tabs/${a.tab_id}/approvals`, { headers: { authorization: `Bearer ${a.tab_token}` } })).status).toBe(403);
    expect((await fetch(`${url}/approvals`)).status).toBe(404);
  });

  it("an agent cannot read another tab's approval", async () => {
    const { body: a } = await openTab();
    const { body: b } = await openTab();
    const id = await pendingApproval(a);
    expect((await fetch(`${url}/approvals/${id}`, { headers: { authorization: `Bearer ${b.tab_token}` } })).status).toBe(404);
    expect((await fetch(`${url}/approvals/${id}`, { headers: { authorization: `Bearer ${a.tab_token}` } })).status).toBe(200);
  });
});

describe("fix 3: event stream is scoped and authenticated", () => {
  it("refuses without the owner token", async () => {
    const { body: tab } = await openTab();
    expect((await fetch(`${url}/tabs/${tab.tab_id}/events`)).status).toBe(401);
    expect((await fetch(`${url}/tabs/${tab.tab_id}/events?token=${tab.tab_token}`)).status).toBe(401);
    expect((await fetch(`${url}/events`)).status).toBe(404);
  });

  it("streams only the owner's tab", async () => {
    const { body: a } = await openTab();
    const { body: b } = await openTab();
    const ac = new AbortController();
    const res = await fetch(`${url}/tabs/${a.tab_id}/events?token=${a.owner_token}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    const reading = (async () => {
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch { /* aborted */ }
    })();
    await post(`/tabs/${b.tab_id}/lines`, { quote: quote(0.1) }, b.tab_token);
    await post(`/tabs/${a.tab_id}/lines`, { quote: quote(0.1) }, a.tab_token);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await reading;
    expect(text).toContain(a.tab_id);
    expect(text).not.toContain(b.tab_id);
  });
});

describe("fix 3: vault allowlist", () => {
  it("rejects a vault id the operator has not linked", async () => {
    const r = await openTab({ vault_id: "someone-elses-vault" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("vault_not_allowed");
  });
  it("accepts the linked vault explicitly or via use_linked_vault", async () => {
    expect((await openTab({ vault_id: LINKED })).body.vault_linked).toBe(true);
    expect((await openTab({ use_linked_vault: true })).body.vault_linked).toBe(true);
    expect((await openTab()).body.vault_linked).toBe(false);
  });
});

describe("startup hardening: receipt keys pasted into a dashboard", () => {
  const good = '{"crv":"Ed25519","x":"pGO3SWg88ODfJcAv1RRLexIiYWL-VyASABsoD5Vr9a4","kty":"OKP"}';
  it("accepts surrounding whitespace and quotes", () => {
    expect(parseJwkEnv("K", `  ${good}\n`)?.kty).toBe("OKP");
    expect(parseJwkEnv("K", `'${good}'`)?.kty).toBe("OKP");
  });
  it("returns undefined instead of throwing on garbage", () => {
    expect(parseJwkEnv("K", "{not json")).toBeUndefined();
    expect(parseJwkEnv("K", '{"kty":"RSA"}')).toBeUndefined();
  });
});
