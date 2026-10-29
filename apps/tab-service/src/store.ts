import type { Policy, Quote, TabLine } from "@agent-tab/shared";

export type Tab = {
  tab_id: string;
  tab_token: string;
  policy: Policy;
  lines: TabLine[];
  blocked: Array<{ at: string; quote: Quote; reason: string }>;
  settlements: Array<{ at: string; amount: number; capture_id?: string; rationale: string }>;
  created_at: string;
  /** PayPal Vault v3 payment token id; set after the buyer approves. */
  vault_id?: string;
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

/** In-memory store for M1. Swap for Prisma on Nov 2 without changing the routes. */
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
    const settled = tab.settlements.reduce((s, x) => s + x.amount, 0);
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
