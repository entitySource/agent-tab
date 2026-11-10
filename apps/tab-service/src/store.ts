import type { Policy, Quote, TabLine } from "@agent-tab/shared";

export type Tab = {
  tab_id: string;
  /** Given to the agent: can add lines, read the tab, close the session. */
  tab_token: string;
  /** Kept by the human: the only credential that can approve, deny, or watch events. */
  owner_token: string;
  policy: Policy;
  lines: TabLine[];
  blocked: Array<{ at: string; quote: Quote; reason: string }>;
  settlements: Settlement[];
  created_at: string;
  /** Set by POST /tabs/:id/close; the treasurer settles whatever is outstanding. */
  session_ended: boolean;
  last_settlement_at?: string;
  /** A failed capture marks the tab delinquent; no further lines are accepted. */
  delinquent: boolean;
  /** PayPal Vault v3 payment token id; set after the buyer approves. */
  vault_id?: string;
};

export type Settlement = {
  settlement_id: string;
  at: string;
  amount: number;
  lines: number;
  status: "completed" | "failed";
  capture_id?: string;
  order_id?: string;
  paypal_fee?: number;
  reason: string;
  rationale: string;
  llm_adjusted: boolean;
};

export type Approval = {
  approval_id: string;
  tab_id: string;
  quote: Quote;
  status: "pending" | "approved" | "denied";
  receipt?: string;
  reason?: string;
  created_at: string;
};

/** In-memory store. A database-backed store can replace it without changing the routes. */
export class MemoryStore {
  tabs = new Map<string, Tab>();
  approvals = new Map<string, Approval>();
  callTimestamps = new Map<string, number[]>();

  spentSession(tab: Tab): number {
    return round2(tab.lines.reduce((s, l) => s + l.quote.price, 0));
  }
  spentToday(tab: Tab, now: Date): number {
    const day = now.toISOString().slice(0, 10);
    return round2(tab.lines.filter((l) => l.created_at.slice(0, 10) === day).reduce((s, l) => s + l.quote.price, 0));
  }
  outstanding(tab: Tab): number {
    const settled = tab.settlements.filter((x) => x.status === "completed").reduce((s, x) => s + x.amount, 0);
    return round2(this.spentSession(tab) - settled);
  }
  callsLastMinute(tabId: string, now: number): number {
    const arr = (this.callTimestamps.get(tabId) ?? []).filter((t) => now - t < 60_000);
    this.callTimestamps.set(tabId, arr);
    return arr.length;
  }
  recordCall(tabId: string, now: number) {
    const arr = this.callTimestamps.get(tabId) ?? [];
    arr.push(now);
    this.callTimestamps.set(tabId, arr);
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
