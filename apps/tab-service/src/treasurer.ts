/**
 * The treasurer decides WHEN to close the tab. The core rule is deterministic and
 * always wins; an optional LLM adds a one-line rationale and may only pull a
 * settlement EARLIER (never later, never past a cap). That boundary is the point.
 */

export type FeeModel = { fixed: number; percent: number };

/** US commercial rate as published; replace with values observed in the Vault spike. */
export const DEFAULT_FEES: FeeModel = { fixed: 0.49, percent: 0.0349 };

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const feeFor = (amount: number, fees: FeeModel = DEFAULT_FEES) => (amount <= 0 ? 0 : round2(fees.fixed + fees.percent * amount));

export type TreasurerInput = {
  outstanding: number;
  settlement_threshold: number;
  session_ended: boolean;
  /** When the current open balance started accruing (last settlement or tab creation). */
  open_since: Date;
  now: Date;
  /** Longest the seller is asked to extend credit before a forced settlement. */
  exposure_window_ms: number;
  /** Lines added in the last minute; a burst is a risk signal the LLM may act on. */
  calls_last_minute: number;
};

export type CoreReason = "nothing_outstanding" | "session_end" | "threshold_reached" | "exposure_window" | "below_threshold";
export type CoreDecision = { settle: boolean; reason: CoreReason };

export function decideCore(i: TreasurerInput): CoreDecision {
  if (i.outstanding <= 0) return { settle: false, reason: "nothing_outstanding" };
  if (i.session_ended) return { settle: true, reason: "session_end" };
  if (i.outstanding >= i.settlement_threshold) return { settle: true, reason: "threshold_reached" };
  if (i.now.getTime() - i.open_since.getTime() >= i.exposure_window_ms) return { settle: true, reason: "exposure_window" };
  return { settle: false, reason: "below_threshold" };
}

export type Advisor = (ctx: {
  input: TreasurerInput;
  core: CoreDecision;
  fees: FeeModel;
  fee_if_settled_now: number;
  fee_share_now: number;
}) => Promise<{ settle_early: boolean; rationale: string }>;

export type TreasurerDecision = CoreDecision & { rationale: string; llm_adjusted: boolean; fee_if_settled_now: number };

export async function decide(i: TreasurerInput, fees: FeeModel = DEFAULT_FEES, advisor?: Advisor): Promise<TreasurerDecision> {
  const core = decideCore(i);
  const fee = feeFor(i.outstanding, fees);
  const share = i.outstanding > 0 ? round2(fee / i.outstanding) : 0;
  const base = templateRationale(core, i, fee, share);

  if (!advisor || core.settle || core.reason === "nothing_outstanding") {
    return { ...core, rationale: base, llm_adjusted: false, fee_if_settled_now: fee };
  }
  try {
    const advice = await advisor({ input: i, core, fees, fee_if_settled_now: fee, fee_share_now: share });
    const rationale = advice.rationale.trim().slice(0, 240) || base;
    // Guardrail: the LLM may only move a HOLD to an early SETTLE, and only when something is owed.
    if (advice.settle_early && i.outstanding > 0) {
      return { settle: true, reason: core.reason, rationale: `early: ${rationale}`, llm_adjusted: true, fee_if_settled_now: fee };
    }
    return { ...core, rationale, llm_adjusted: false, fee_if_settled_now: fee };
  } catch {
    return { ...core, rationale: base, llm_adjusted: false, fee_if_settled_now: fee };
  }
}

function templateRationale(core: CoreDecision, i: TreasurerInput, fee: number, share: number): string {
  const owed = `$${i.outstanding.toFixed(2)} outstanding`;
  switch (core.reason) {
    case "nothing_outstanding": return "Nothing on the tab; nothing to settle.";
    case "session_end": return `Session ended with ${owed}; settling once (fee $${fee.toFixed(2)}).`;
    case "threshold_reached": return `${owed} reached the $${i.settlement_threshold.toFixed(2)} threshold; one capture costs $${fee.toFixed(2)} (${Math.round(share * 100)}% of the tab).`;
    case "exposure_window": return `${owed} has been open past the exposure window; settling to limit seller credit risk.`;
    case "below_threshold": return `${owed}; settling now would cost $${fee.toFixed(2)} (${Math.round(share * 100)}%), so holding until $${i.settlement_threshold.toFixed(2)}.`;
  }
}

/** What per-call billing would have cost versus what the tab actually paid. */
export function feeComparison(linePrices: number[], settlementAmounts: number[], fees: FeeModel = DEFAULT_FEES) {
  const naive = round2(linePrices.reduce((s, p) => s + feeFor(p, fees), 0));
  const actual = round2(settlementAmounts.reduce((s, a) => s + feeFor(a, fees), 0));
  const usage = round2(linePrices.reduce((s, p) => s + p, 0));
  return { usage, calls: linePrices.length, settlements: settlementAmounts.length, naive_fees: naive, tab_fees: actual, saved: round2(naive - actual) };
}
