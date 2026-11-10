const rawUrl = (import.meta.env.VITE_TAB_SERVICE_URL as string | undefined) ?? "http://localhost:4100";
export const TAB_SERVICE_URL = /^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

export type Policy = {
  per_call_cap: number; session_cap: number; daily_cap: number; merchant_allowlist: string[];
  approval_threshold: number; settlement_threshold: number; max_calls_per_minute: number; expires_at: string;
};
export type Quote = { quote_id: string; merchant_id: string; price: number; currency: string; resource: string; expires_at: string };
export type Line = { line_id: string; quote: Quote; created_at: string; approved_by_human: boolean };
export type Blocked = { at: string; quote: Quote; reason: string };
export type Settlement = { settlement_id: string; at: string; amount: number; lines: number; status: "completed" | "failed"; capture_id?: string; order_id?: string; paypal_fee?: number; reason: string; rationale: string; llm_adjusted: boolean };
export type TabState = {
  tab_id: string; policy: Policy; spent_session: number; spent_today: number; outstanding: number;
  lines: Line[]; blocked: Blocked[]; settlements: Settlement[]; vault_linked: boolean; session_ended: boolean; delinquent: boolean;
};
export type Metrics = { usage: number; calls: number; settlements: number; naive_fees: number; tab_fees: number; saved: number; blocked: number; approvals: number; delinquent: boolean; gateway: string };
export type Approval = { approval_id: string; tab_id: string; quote: Quote; status: string; created_at: string };
/** The ledger is the human's view, so it holds the owner token, never the agent's tab token. */
export type Creds = { tab_id: string; owner_token: string };
export type CreatedTab = { tab_id: string; tab_token: string; owner_token: string; policy: Policy; vault_linked: boolean };

const json = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const auth = (c: Creds) => ({ authorization: `Bearer ${c.owner_token}` });
const tabUrl = (c: Creds, path = "") => `${TAB_SERVICE_URL}/tabs/${encodeURIComponent(c.tab_id)}${path}`;

export const api = {
  createTab: (policy: Policy, useLinkedVault: boolean) =>
    fetch(`${TAB_SERVICE_URL}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy, use_linked_vault: useLinkedVault }) }).then(json<CreatedTab>),
  getTab: (c: Creds) => fetch(tabUrl(c), { headers: auth(c) }).then(json<TabState>),
  getMetrics: (c: Creds) => fetch(tabUrl(c, "/metrics"), { headers: auth(c) }).then(json<Metrics>),
  closeTab: (c: Creds) => fetch(tabUrl(c, "/close"), { method: "POST", headers: auth(c) }).then(json<unknown>),
  listApprovals: (c: Creds) => fetch(tabUrl(c, "/approvals"), { headers: auth(c) }).then(json<Approval[]>),
  decide: (c: Creds, id: string, verb: "approve" | "deny") =>
    fetch(`${TAB_SERVICE_URL}/approvals/${encodeURIComponent(id)}/${verb}`, { method: "POST", headers: auth(c) }).then(json<unknown>),
  events: (c: Creds, onEvent: (name: string, data: unknown) => void) => {
    // EventSource cannot send headers; the owner token goes in the query string over HTTPS.
    const es = new EventSource(tabUrl(c, `/events?token=${encodeURIComponent(c.owner_token)}`));
    const names = ["line.added", "line.blocked", "approval.requested", "approval.approved", "approval.denied", "treasurer.decision", "settlement.completed", "settlement.failed"];
    for (const n of names) es.addEventListener(n, (e) => onEvent(n, JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  },
};

const KEY = "agent-tab.owner-creds.v2";
export function loadCreds(): Creds | null {
  try {
    const raw = localStorage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as Partial<Creds>) : null;
    return c?.tab_id && c?.owner_token ? { tab_id: c.tab_id, owner_token: c.owner_token } : null;
  } catch { return null; }
}
export function saveCreds(c: Creds | null) {
  try { if (c) localStorage.setItem(KEY, JSON.stringify(c)); else localStorage.removeItem(KEY); } catch { /* ignore */ }
}
