import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { Policy, Quote, evaluate, signReceipt, type TabLine } from "@agent-tab/shared";
import { MemoryStore, type Settlement, type Tab } from "./store.js";
import { MockGateway, type PaymentGateway } from "./gateway.js";
import { DEFAULT_FEES, decide, feeComparison, type Advisor, type FeeModel } from "./treasurer.js";

export type AppOptions = {
  gateway?: PaymentGateway;
  advisor?: Advisor;
  fees?: FeeModel;
  /** Max time an open balance may accrue before a forced settlement. */
  exposureWindowMs?: number;
};

export type Keys = { privateJwk: JWK; publicJwk: JWK };

export async function loadOrCreateKeys(): Promise<Keys> {
  const priv = process.env.RECEIPT_PRIVATE_KEY_JWK;
  const pub = process.env.RECEIPT_PUBLIC_KEY_JWK;
  if (priv && pub) return { privateJwk: JSON.parse(priv), publicJwk: JSON.parse(pub) };
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const keys = { privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) };
  if (process.env.NODE_ENV !== "test") {
    console.warn("[tab-service] RECEIPT_*_JWK not set; generated an ephemeral keypair. Receipts will not survive a restart.");
  }
  return keys;
}

export function createApp(keys: Keys, store = new MemoryStore(), options: AppOptions = {}) {
  const gateway = options.gateway ?? new MockGateway();
  const fees = options.fees ?? DEFAULT_FEES;
  const exposureWindowMs = options.exposureWindowMs ?? 30 * 60_000;
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  const listeners = new Set<Response>();
  const emit = (event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(line);
  };

  const authTab = (req: Request, res: Response, next: NextFunction) => {
    const tab = store.tabs.get(req.params.id);
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!tab || !token || token !== tab.tab_token) { res.status(401).json({ error: "unauthorized" }); return; }
    res.locals.tab = tab;
    next();
  };

  app.get("/.well-known/agent-tab.json", (_req, res) => {
    res.json({ receipt_public_key_jwk: keys.publicJwk, version: "0.1" });
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  /** Human creates a tab with a policy. Returns the tab token the agent will use. */
  app.post("/tabs", (req, res) => {
    const parsed = Policy.safeParse(req.body?.policy);
    if (!parsed.success) { res.status(400).json({ error: "invalid_policy", issues: parsed.error.issues }); return; }
    const tab: Tab = {
      tab_id: `tab_${randomUUID()}`,
      tab_token: randomBytes(24).toString("base64url"),
      policy: parsed.data,
      lines: [],
      blocked: [],
      settlements: [],
      created_at: new Date().toISOString(),
      session_ended: false,
      delinquent: false,
      vault_id: typeof req.body?.vault_id === "string" ? req.body.vault_id : undefined,
    };
    store.tabs.set(tab.tab_id, tab);
    emit("tab.created", { tab_id: tab.tab_id });
    res.status(201).json({ tab_id: tab.tab_id, tab_token: tab.tab_token, policy: tab.policy });
  });

  app.get("/tabs/:id", authTab, (_req, res) => {
    const tab = res.locals.tab as Tab;
    const now = new Date();
    res.json({
      tab_id: tab.tab_id,
      policy: tab.policy,
      spent_session: store.spentSession(tab),
      spent_today: store.spentToday(tab, now),
      outstanding: store.outstanding(tab),
      lines: tab.lines,
      blocked: tab.blocked,
      settlements: tab.settlements,
      vault_linked: Boolean(tab.vault_id),
      session_ended: tab.session_ended,
      delinquent: tab.delinquent,
    });
  });

  /** Agent asks to put a quoted call on the tab. Policy is enforced here, never in the agent. */
  app.post("/tabs/:id/lines", authTab, async (req, res) => {
    const tab = res.locals.tab as Tab;
    const q = Quote.safeParse(req.body?.quote);
    if (!q.success) { res.status(400).json({ error: "invalid_quote", issues: q.error.issues }); return; }
    const quote = q.data;
    const now = new Date();
    if (tab.delinquent || tab.session_ended) {
      const reason = tab.delinquent ? "tab_delinquent" : "session_ended";
      tab.blocked.push({ at: now.toISOString(), quote, reason });
      emit("line.blocked", { tab_id: tab.tab_id, quote, reason });
      res.status(403).json({ error: "denied", reason });
      return;
    }
    const decision = evaluate(quote, tab.policy, {
      spent_session: store.spentSession(tab),
      spent_today: store.spentToday(tab, now),
      calls_last_minute: store.callsLastMinute(tab.tab_id, now.getTime()),
      now,
    });
    if (!decision.allow) {
      tab.blocked.push({ at: now.toISOString(), quote, reason: decision.reason });
      emit("line.blocked", { tab_id: tab.tab_id, quote, reason: decision.reason });
      res.status(403).json({ error: "denied", reason: decision.reason });
      return;
    }
    if (decision.needs_approval) {
      const approval = {
        approval_id: `apr_${randomUUID()}`,
        tab_id: tab.tab_id,
        quote,
        status: "pending" as const,
        created_at: now.toISOString(),
      };
      store.approvals.set(approval.approval_id, approval);
      emit("approval.requested", approval);
      res.status(202).json({ approval_id: approval.approval_id, status: "pending" });
      return;
    }
    const line = await addLine(tab, quote, false);
    res.status(201).json({ line_id: line.line_id, receipt: line.receipt, outstanding: store.outstanding(tab) });
  });

  async function addLine(tab: Tab, quote: Quote, approved: boolean) {
    const now = new Date();
    const line: TabLine = {
      line_id: `ln_${randomUUID()}`,
      tab_id: tab.tab_id,
      quote,
      created_at: now.toISOString(),
      approved_by_human: approved,
    };
    tab.lines.push(line);
    store.recordCall(tab.tab_id, now.getTime());
    const receipt = await signReceipt(
      { line_id: line.line_id, tab_id: tab.tab_id, quote_id: quote.quote_id, merchant_id: quote.merchant_id, price: quote.price, nonce: randomUUID() },
      keys.privateJwk,
    );
    emit("line.added", { tab_id: tab.tab_id, line, outstanding: store.outstanding(tab) });
    // The treasurer looks at the tab after every line. Settlement is awaited so the
    // ledger is consistent by the time the agent gets its receipt.
    await runTreasurer(tab);
    return { ...line, receipt };
  }

  async function runTreasurer(tab: Tab): Promise<Settlement | undefined> {
    const now = new Date();
    const decision = await decide(
      {
        outstanding: store.outstanding(tab),
        settlement_threshold: tab.policy.settlement_threshold,
        session_ended: tab.session_ended,
        open_since: new Date(tab.last_settlement_at ?? tab.created_at),
        now,
        exposure_window_ms: exposureWindowMs,
        calls_last_minute: store.callsLastMinute(tab.tab_id, now.getTime()),
      },
      fees,
      options.advisor,
    );
    emit("treasurer.decision", { tab_id: tab.tab_id, ...decision });
    if (!decision.settle) return undefined;
    return settle(tab, decision.reason, decision.rationale, decision.llm_adjusted);
  }

  async function settle(tab: Tab, reason: string, rationale: string, llmAdjusted: boolean): Promise<Settlement> {
    const amount = store.outstanding(tab);
    const n = tab.settlements.length + 1;
    const base = { settlement_id: `stl_${randomUUID()}`, at: new Date().toISOString(), amount, lines: tab.lines.length, reason, rationale, llm_adjusted: llmAdjusted };
    if (!tab.vault_id && gateway.name !== "mock") {
      const failed: Settlement = { ...base, status: "failed", reason: "no_vault_linked" };
      tab.settlements.push(failed);
      tab.delinquent = true;
      emit("settlement.failed", failed);
      return failed;
    }
    const result = await gateway.capture({
      vault_id: tab.vault_id ?? "mock-vault",
      amount,
      reference: `${tab.tab_id}:${n}`,
      description: `Agent Tab settlement ${n} (${tab.lines.length} metered calls)`,
    });
    let settlement: Settlement;
    if (result.ok) {
      settlement = { ...base, status: "completed", capture_id: result.capture_id, order_id: result.order_id, paypal_fee: result.paypal_fee };
      tab.last_settlement_at = settlement.at;
    } else {
      settlement = { ...base, status: "failed", reason: result.error };
      tab.delinquent = true;
    }
    tab.settlements.push(settlement);
    emit(result.ok ? "settlement.completed" : "settlement.failed", settlement);
    return settlement;
  }

  /** Human or agent ends the session: whatever is outstanding settles now. */
  app.post("/tabs/:id/close", authTab, async (_req, res) => {
    const tab = res.locals.tab as Tab;
    tab.session_ended = true;
    const settlement = await runTreasurer(tab);
    res.json({ tab_id: tab.tab_id, session_ended: true, settlement: settlement ?? null, outstanding: store.outstanding(tab) });
  });

  /** Force a treasurer evaluation (used by the periodic exposure-window sweep). */
  app.post("/tabs/:id/evaluate", authTab, async (_req, res) => {
    const tab = res.locals.tab as Tab;
    const settlement = await runTreasurer(tab);
    res.json({ settlement: settlement ?? null, outstanding: store.outstanding(tab) });
  });

  /** The numbers for the video: per-call billing vs the tab. */
  app.get("/tabs/:id/metrics", authTab, (_req, res) => {
    const tab = res.locals.tab as Tab;
    const completed = tab.settlements.filter((s) => s.status === "completed");
    const cmp = feeComparison(tab.lines.map((l) => l.quote.price), completed.map((s) => s.amount), fees);
    res.json({ ...cmp, blocked: tab.blocked.length, approvals: tab.lines.filter((l) => l.approved_by_human).length, delinquent: tab.delinquent, gateway: gateway.name });
  });

  /** Periodic sweep so an idle tab still settles once its exposure window passes. */
  (app as unknown as { sweep: () => Promise<void> }).sweep = async () => {
    for (const tab of store.tabs.values()) if (!tab.delinquent) await runTreasurer(tab);
  };

  app.get("/approvals/:id", (req, res) => {
    const a = store.approvals.get(req.params.id);
    if (!a) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ approval_id: a.approval_id, status: a.status, receipt: a.receipt, reason: a.reason, quote: a.quote });
  });

  /** Human decision. In the demo this is the approval inbox; here it is a plain endpoint. */
  app.post("/approvals/:id/:verb(approve|deny)", async (req, res) => {
    const a = store.approvals.get(req.params.id);
    if (!a) { res.status(404).json({ error: "not_found" }); return; }
    if (a.status !== "pending") { res.status(409).json({ error: "already_decided", status: a.status }); return; }
    const tab = store.tabs.get(a.tab_id)!;
    if (req.params.verb === "deny") {
      a.status = "denied";
      const reason: string = typeof req.body?.reason === "string" ? req.body.reason : "denied_by_human";
      a.reason = reason;
      tab.blocked.push({ at: new Date().toISOString(), quote: a.quote, reason });
      emit("approval.denied", a);
      res.json({ status: a.status });
      return;
    }
    const line = await addLine(tab, a.quote, true);
    a.status = "approved";
    a.receipt = line.receipt;
    emit("approval.approved", { approval_id: a.approval_id, line_id: line.line_id });
    res.json({ status: a.status, line_id: line.line_id });
  });

  app.get("/approvals", (_req, res) => {
    res.json([...store.approvals.values()].filter((a) => a.status === "pending"));
  });

  /** Server-sent events for the ledger UI. */
  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`event: hello\ndata: {}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
  });

  return app;
}
