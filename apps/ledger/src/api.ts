export const TAB_SERVICE_URL = (import.meta.env.VITE_TAB_SERVICE_URL as string | undefined) ?? "http://localhost:4100";

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
export type Creds = { tab_id: string; tab_token: string };

const json = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const auth = (c: Creds) => ({ authorization: `Bearer ${c.tab_token}` });

export const api = {
  createTab: (policy: Policy, vault_id?: string) =>
    fetch(`${TAB_SERVICE_URL}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy, vault_id }) }).then(json<Creds & { policy: Policy }>),
  getTab: (c: Creds) => fetch(`${TAB_SERVICE_URL}/tabs/${c.tab_id}`, { headers: auth(c) }).then(json<TabState>),
  getMetrics: (c: Creds) => fetch(`${TAB_SERVICE_URL}/tabs/${c.tab_id}/metrics`, { headers: auth(c) }).then(json<Metrics>),
  closeTab: (c: Creds) => fetch(`${TAB_SERVICE_URL}/tabs/${c.tab_id}/close`, { method: "POST", headers: auth(c) }).then(json<unknown>),
  listApprovals: () => fetch(`${TAB_SERVICE_URL}/approvals`).then(json<Approval[]>),
  decide: (id: string, verb: "approve" | "deny") => fetch(`${TAB_SERVICE_URL}/approvals/${id}/${verb}`, { method: "POST" }).then(json<unknown>),
  events: (onEvent: (name: string, data: unknown) => void) => {
    const es = new EventSource(`${TAB_SERVICE_URL}/events`);
    const names = ["tab.created", "line.added", "line.blocked", "approval.requested", "approval.approved", "approval.denied", "treasurer.decision", "settlement.completed", "settlement.failed"];
    for (const n of names) es.addEventListener(n, (e) => onEvent(n, JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  },
};

export function loadCreds(): Creds | null {
  try { const raw = localStorage.getItem("agent-tab.creds"); return raw ? (JSON.parse(raw) as Creds) : null; } catch { return null; }
}
export function saveCreds(c: Creds | null) {
  try { if (c) localStorage.setItem("agent-tab.creds", JSON.stringify(c)); else localStorage.removeItem("agent-tab.creds"); } catch { /* ignore */ }
}
