import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
// Load .env from the current directory first, then from the repo root, so every app works
// whether started from the root, its own folder, or compiled dist/.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { mkdirSync, writeFileSync } from "node:fs";
import { createTabClient } from "@agent-tab/client";
import { makeTools, runScripted, runWithModel, type Step } from "./agent.js";

const tabServiceUrl = process.env.TAB_SERVICE_URL ?? "http://localhost:4100";
const apiUrl = process.env.PAID_API_URL ?? "http://localhost:4200";
const question = process.argv.slice(2).join(" ") || "What is the state of agentic commerce and why does per-call billing lose money?";
const model = process.env.AGENT_TAB_MODEL ?? "claude-sonnet-5-5";
const useModel = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.AGENT_MODE !== "scripted";

/** Demo policy: $0.30 per call, $5 per session, approvals above $0.20, settle every $1. */
const DEMO_POLICY = {
  per_call_cap: 0.3, session_cap: 5, daily_cap: 20, merchant_allowlist: [process.env.PAID_API_MERCHANT_ID ?? "research-data-demo"],
  approval_threshold: 0.2, settlement_threshold: 1, max_calls_per_minute: 60,
  expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
};

async function ensureTab(): Promise<{ tab_id: string; tab_token: string; owner_token?: string; created: boolean }> {
  if (process.env.TAB_ID && process.env.TAB_TOKEN) return { tab_id: process.env.TAB_ID, tab_token: process.env.TAB_TOKEN, created: false };
  // No tab given: open one with the demo policy, charging the vault the tab service has linked (if any).
  const r = await fetch(`${tabServiceUrl}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: DEMO_POLICY, use_linked_vault: true }) });
  if (!r.ok) throw new Error(`could not create tab: ${r.status} ${await r.text()}`);
  const t = (await r.json()) as { tab_id: string; tab_token: string; owner_token: string };
  return { ...t, created: true };
}

const tab = await ensureTab();
if (tab.owner_token) {
  console.log(`[agent] approvals for this tab need its owner token. In the ledger choose "Open an existing tab" with:`);
  console.log(`[agent]   tab id      ${tab.tab_id}`);
  console.log(`[agent]   owner token ${tab.owner_token}`);
}
const auth = { authorization: `Bearer ${tab.tab_token}` };
console.log(`[agent] tab ${tab.tab_id}${tab.created ? " (created with demo policy)" : ""}`);
console.log(`[agent] mode: ${useModel ? `model ${model}` : "scripted (no ANTHROPIC_API_KEY)"}`);

const steps: Step[] = [];
const paidFetch = createTabClient({
  tabServiceUrl, tabId: tab.tab_id, tabToken: tab.tab_token,
  onApprovalNeeded: ({ approval_id, quote }) => console.log(`[agent] $${quote.price.toFixed(2)} call needs human approval -> ${approval_id} (approve in the ledger UI)`),
});
const tools = makeTools(paidFetch, apiUrl, steps);

const started = Date.now();
const result = useModel ? await runWithModel(question, tools, steps, model) : await runScripted(question, tools, steps);

for (const s of steps) console.log(`[agent] ${s.outcome === "ok" ? "ok " : "NO "} ${s.tool} ${JSON.stringify(s.args)}${s.detail ? ` (${s.detail})` : ""}`);

if (process.env.AGENT_CLOSE_TAB !== "false") {
  const closed = (await fetch(`${tabServiceUrl}/tabs/${tab.tab_id}/close`, { method: "POST", headers: auth }).then((r) => r.json())) as { settlement: { capture_id?: string; amount: number; rationale: string } | null };
  if (closed.settlement) console.log(`[agent] session closed; settled $${closed.settlement.amount.toFixed(2)} -> ${closed.settlement.capture_id ?? "n/a"} (${closed.settlement.rationale})`);
  else console.log("[agent] session closed; nothing outstanding");
}

const m = (await fetch(`${tabServiceUrl}/tabs/${tab.tab_id}/metrics`, { headers: auth }).then((r) => r.json())) as Record<string, number | string | boolean>;
const footer = [
  "", "---", "", "### Cost of this report (metered through Agent Tab)", "",
  `| Calls | Usage | Settlements | Fees if billed per call | Fees via tab | Saved | Blocked |`,
  `|---|---|---|---|---|---|---|`,
  `| ${m.calls} | $${Number(m.usage).toFixed(2)} | ${m.settlements} | $${Number(m.naive_fees).toFixed(2)} | $${Number(m.tab_fees).toFixed(2)} | $${Number(m.saved).toFixed(2)} | ${m.blocked} |`,
  "", `Gateway: ${m.gateway}. Generated in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
].join("\n");

mkdirSync("reports", { recursive: true });
const file = `reports/${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
writeFileSync(file, result.report + "\n" + footer + "\n");
console.log(`[agent] report written to ${file}`);
console.log(footer);
