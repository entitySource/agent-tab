import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { Policy, Quote, evaluate, signReceipt, type TabLine } from "@agent-tab/shared";
import { MemoryStore, type Approval, type Settlement, type Tab } from "./store.js";
import { MockGateway, type PaymentGateway } from "./gateway.js";
import { DEFAULT_FEES, decide, feeComparison, type Advisor, type FeeModel } from "./treasurer.js";

export type AppOptions = {
  gateway?: PaymentGateway;
  advisor?: Advisor;
  fees?: FeeModel;
  /** Max time an open balance may accrue before a forced settlement. */
  exposureWindowMs?: number;
  /**
   * PayPal vault ids this deployment's operator has linked. Tabs may only charge these.
   * A vault id is a standing permission to charge someone, so it is never taken from a client.
   */
  allowedVaultIds?: string[];
};

export type Keys = { privateJwk: JWK; publicJwk: JWK };

/** Accepts a JWK pasted with stray whitespace or wrapping quotes, as hosting dashboards often produce. */
export function parseJwkEnv(name: string, raw: string | undefined): JWK | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1).replace(/\\"/g, '"').trim();
  try {
    const jwk = JSON.parse(s) as JWK;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("not an Ed25519 JWK");
    return jwk;
  } catch (err) {
    console.error(`[tab-service] ${name} is set but is not a valid Ed25519 JWK (${(err as Error).message}). Paste the whole {...} value on one line.`);
    return undefined;
  }
}

export async function loadOrCreateKeys(): Promise<Keys> {
  const priv = parseJwkEnv("RECEIPT_PRIVATE_KEY_JWK", process.env.RECEIPT_PRIVATE_KEY_JWK);
  const pub = parseJwkEnv("RECEIPT_PUBLIC_KEY_JWK", process.env.RECEIPT_PUBLIC_KEY_JWK);
  if (priv && pub && typeof priv.d === "string") return { privateJwk: priv, publicJwk: pub };
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const keys = { privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) };
  if (process.env.NODE_ENV !== "test") {
    console.warn("[tab-service] Using an ephemeral receipt keypair; receipts will not survive a restart.");
  }
  return keys;
}

const newToken = () => randomBytes(24).toString("base64url");
const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
type Role = "agent" | "owner";
const roleFor = (tab: Tab, token: string): Role | null =>
  !token ? null : sameToken(token, tab.owner_token) ? "owner" : sameToken(token, tab.tab_token) ? "agent" : null;
const bearer = (req: Request) => (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

export function createApp(keys: Keys, store = new MemoryStore(), options: AppOptions = {}) {
  const gateway = options.gateway ?? new MockGateway();
  const fees = options.fees ?? DEFAULT_FEES;
  const exposureWindowMs = options.exposureWindowMs ?? 30 * 60_000;
  const allowedVaults = (options.allowedVaultIds ?? []).filter(Boolean);
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  // The ledger UI runs on another origin. Credentials travel in the Authorization header,
  // never in cookies, so a permissive origin does not let other sites act as the user.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "authorization, content-type");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  // ---- events: each listener is scoped to one tab -------------------------------------
  const listeners = new Map<Response, string>(); // response -> tab_id
  const emit = (tabId: string, event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, scope] of listeners) if (scope === tabId) res.write(line);
  };

  // ---- auth --------------------------------------------------------------------------
  const auth = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
    const tab = store.tabs.get(req.params.id);
    const role = tab ? roleFor(tab, bearer(req)) : null;
    if (!tab || !role) { res.status(401).json({ error: "unauthorized" }); return; }
    if (!roles.includes(role)) { res.status(403).json({ error: "forbidden", detail: `requires ${roles.join(" or ")} token` }); return; }
    res.locals.tab = tab;
    res.locals.role = role;
    next();
  };

  // ---- per-tab serialisation of treasurer runs (fix 2) ---------------------------------
  // Without this, two lines arriving together could both see the same outstanding balance
  // and both capture it. Each tab's treasurer runs strictly one after another; a later run
  // re-reads the balance after the earlier settlement has been recorded.
  const tails = new Map<string, Promise<unknown>>();
  function serialised<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(tabId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(tabId, tail);
    void tail.then(() => { if (tails.get(tabId) === tail) tails.delete(tabId); });
    return run;
  }

  app.get("/.well-known/agent-tab.json", (_req, res) => {
    res.json({ receipt_public_key_jwk: keys.publicJwk, version: "0.2" });
  });

  app.get("/health", (_req, res) => res.json({ ok: true, gateway: gateway.name, linked_vaults: allowedVaults.length }));

  /**
   * Human creates a tab. Returns two credentials, once:
   *  - tab_token for the agent (add lines, read, close)
   *  - owner_token for the human (approve, deny, watch events, read, close)
   * A vault is attached only from the operator's allowlist (fix 3).
   */
  app.post("/tabs", (req, res) => {
    const parsed = Policy.safeParse(req.body?.policy);
    if (!parsed.success) { res.status(400).json({ error: "invalid_policy", issues: parsed.error.issues }); return; }
    let vaultId: string | undefined;
    const requested = req.body?.vault_id;
    if (typeof requested === "string" && requested.length > 0) {
      if (!allowedVaults.includes(requested)) { res.status(403).json({ error: "vault_not_allowed", detail: "this deployment only charges vaults its operator has linked" }); return; }
      vaultId = requested;
    } else if (req.body?.use_linked_vault === true) {
      vaultId = allowedVaults[0]; // undefined when none is linked; settlement then reports no_vault_linked
    }
    const tab: Tab = {
      tab_id: `tab_${randomUUID()}`,
      tab_token: newToken(),
      owner_token: newToken(),
      policy: parsed.data,
      lines: [],
      blocked: [],
      settlements: [],
      created_at: new Date().toISOString(),
      session_ended: false,
      delinquent: false,
      vault_id: vaultId,
    };
    store.tabs.set(tab.tab_id, tab);
    res.status(201).json({ tab_id: tab.tab_id, tab_token: tab.tab_token, owner_token: tab.owner_token, policy: tab.policy, vault_linked: Boolean(vaultId) });
  });

  app.get("/tabs/:id", auth("agent", "owner"), (_req, res) => {
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
  app.post("/tabs/:id/lines", auth("agent"), async (req, res) => {
    const tab = res.locals.tab as Tab;
    const q = Quote.safeParse(req.body?.quote);
    if (!q.success) { res.status(400).json({ error: "invalid_quote", issues: q.error.issues }); return; }
    const quote = q.data;
    const now = new Date();
    if (tab.delinquent || tab.session_ended) {
      const reason = tab.delinquent ? "tab_delinquent" : "session_ended";
      tab.blocked.push({ at: now.toISOString(), quote, reason });
      emit(tab.tab_id, "line.blocked", { tab_id: tab.tab_id, quote, reason });
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
      emit(tab.tab_id, "line.blocked", { tab_id: tab.tab_id, quote, reason: decision.reason });
      res.status(403).json({ error: "denied", reason: decision.reason });
      return;
    }
    if (decision.needs_approval) {
      const approval: Approval = {
        approval_id: `apr_${randomUUID()}`,
        tab_id: tab.tab_id,
        quote,
        status: "pending",
        created_at: now.toISOString(),
      };
      store.approvals.set(approval.approval_id, approval);
      emit(tab.tab_id, "approval.requested", approval);
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
    // Recorded synchronously, before any await, so concurrent policy checks see it.
    tab.lines.push(line);
    store.recordCall(tab.tab_id, now.getTime());
    const receipt = await signReceipt(
      { line_id: line.line_id, tab_id: tab.tab_id, quote_id: quote.quote_id, merchant_id: quote.merchant_id, price: quote.price, nonce: randomUUID() },
      keys.privateJwk,
    );
    emit(tab.tab_id, "line.added", { tab_id: tab.tab_id, line, outstanding: store.outstanding(tab) });
    // The treasurer looks at the tab after every line. Settlement is awaited so the
    // ledger is consistent by the time the agent gets its receipt.
    await runTreasurer(tab);
    return { ...line, receipt };
  }

  function runTreasurer(tab: Tab): Promise<Settlement | undefined> {
    return serialised(tab.tab_id, async () => {
      if (tab.delinquent) return undefined;
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
      emit(tab.tab_id, "treasurer.decision", { tab_id: tab.tab_id, ...decision });
      if (!decision.settle) return undefined;
      return settle(tab, decision.reason, decision.rationale, decision.llm_adjusted);
    });
  }

  /** Only ever called inside serialised(); never concurrently for the same tab. */
  async function settle(tab: Tab, reason: string, rationale: string, llmAdjusted: boolean): Promise<Settlement> {
    const amount = store.outstanding(tab);
    const n = tab.settlements.length + 1;
    const base = { settlement_id: `stl_${randomUUID()}`, at: new Date().toISOString(), amount, lines: tab.lines.length, reason, rationale, llm_adjusted: llmAdjusted };
    if (!tab.vault_id && gateway.name !== "mock") {
      const failed: Settlement = { ...base, status: "failed", reason: "no_vault_linked" };
      tab.settlements.push(failed);
      tab.delinquent = true;
      emit(tab.tab_id, "settlement.failed", { tab_id: tab.tab_id, ...failed });
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
    emit(tab.tab_id, result.ok ? "settlement.completed" : "settlement.failed", { tab_id: tab.tab_id, ...settlement });
    return settlement;
  }

  /** Agent or human ends the session: whatever is outstanding settles now. */
  app.post("/tabs/:id/close", auth("agent", "owner"), async (_req, res) => {
    const tab = res.locals.tab as Tab;
    tab.session_ended = true;
    const settlement = await runTreasurer(tab);
    res.json({ tab_id: tab.tab_id, session_ended: true, settlement: settlement ?? null, outstanding: store.outstanding(tab) });
  });

  /** Force a treasurer evaluation. */
  app.post("/tabs/:id/evaluate", auth("agent", "owner"), async (_req, res) => {
    const tab = res.locals.tab as Tab;
    const settlement = await runTreasurer(tab);
    res.json({ settlement: settlement ?? null, outstanding: store.outstanding(tab) });
  });

  /** The numbers for the video: per-call billing vs the tab. */
  app.get("/tabs/:id/metrics", auth("agent", "owner"), (_req, res) => {
    const tab = res.locals.tab as Tab;
    const completed = tab.settlements.filter((s) => s.status === "completed");
    const cmp = feeComparison(tab.lines.map((l) => l.quote.price), completed.map((s) => s.amount), fees);
    res.json({ ...cmp, blocked: tab.blocked.length, approvals: tab.lines.filter((l) => l.approved_by_human).length, delinquent: tab.delinquent, gateway: gateway.name });
  });

  /** Pending approvals for one tab: the human's inbox. */
  app.get("/tabs/:id/approvals", auth("owner"), (_req, res) => {
    const tab = res.locals.tab as Tab;
    res.json([...store.approvals.values()].filter((a) => a.tab_id === tab.tab_id && a.status === "pending"));
  });

  /**
   * Live events for one tab, owner only. EventSource cannot send headers, so the owner
   * token may also arrive as ?token=. Use HTTPS so it is not exposed in transit.
   */
  app.get("/tabs/:id/events", (req, res) => {
    const tab = store.tabs.get(req.params.id);
    const token = bearer(req) || (typeof req.query.token === "string" ? req.query.token : "");
    if (!tab || roleFor(tab, token) !== "owner") { res.status(401).json({ error: "unauthorized" }); return; }
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ tab_id: tab.tab_id })}\n\n`);
    listeners.set(res, tab.tab_id);
    req.on("close", () => listeners.delete(res));
  });

  /** Periodic sweep so an idle tab still settles once its exposure window passes. */
  (app as unknown as { sweep: () => Promise<void> }).sweep = async () => {
    for (const tab of store.tabs.values()) if (!tab.delinquent) await runTreasurer(tab);
  };

  /** The agent polls its own approval; the human may read it too. */
  app.get("/approvals/:id", (req, res) => {
    const a = store.approvals.get(req.params.id);
    const tab = a ? store.tabs.get(a.tab_id) : undefined;
    if (!a || !tab || !roleFor(tab, bearer(req))) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ approval_id: a.approval_id, status: a.status, receipt: a.receipt, reason: a.reason, quote: a.quote });
  });

  /** Human decision, owner token only. The agent cannot approve its own request. */
  app.post("/approvals/:id/:verb(approve|deny)", async (req, res) => {
    const a = store.approvals.get(req.params.id);
    const tab = a ? store.tabs.get(a.tab_id) : undefined;
    if (!a || !tab) { res.status(404).json({ error: "not_found" }); return; }
    const role = roleFor(tab, bearer(req));
    if (!role) { res.status(401).json({ error: "unauthorized" }); return; }
    if (role !== "owner") { res.status(403).json({ error: "forbidden", detail: "only the tab owner can decide approvals" }); return; }
    if (a.status !== "pending") { res.status(409).json({ error: "already_decided", status: a.status }); return; }
    if (req.params.verb === "deny") {
      a.status = "denied";
      const reason: string = typeof req.body?.reason === "string" ? req.body.reason : "denied_by_human";
      a.reason = reason;
      tab.blocked.push({ at: new Date().toISOString(), quote: a.quote, reason });
      emit(tab.tab_id, "approval.denied", a);
      res.json({ status: a.status });
      return;
    }
    // Claim the approval before any await so a double click cannot add the line twice.
    a.status = "approved";
    const line = await addLine(tab, a.quote, true);
    a.receipt = line.receipt;
    emit(tab.tab_id, "approval.approved", { tab_id: tab.tab_id, approval_id: a.approval_id, line_id: line.line_id });
    res.json({ status: a.status, line_id: line.line_id });
  });

  return app;
}
