import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { AgCharts } from "ag-charts-react";
import type { AgChartOptions } from "ag-charts-community";
import { api, loadCreds, saveCreds, type Approval, type Blocked, type Creds, type Line, type Metrics, type Policy, type Settlement, type TabState } from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  backgroundColor: "#0f1420", foregroundColor: "#e6e9f0", headerBackgroundColor: "#161c2b", borderColor: "#263046",
  rowHoverColor: "#1b2335", accentColor: "#5b8cff", fontFamily: "Inter, system-ui, sans-serif", fontSize: 13, headerFontSize: 12,
});

const usd = (n: number | undefined) => (n == null ? "" : `$${n.toFixed(2)}`);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const DEFAULT_POLICY: Policy = {
  per_call_cap: 0.3, session_cap: 5, daily_cap: 20, merchant_allowlist: ["research-data-demo"],
  approval_threshold: 0.2, settlement_threshold: 1, max_calls_per_minute: 60, expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
};

export function App() {
  const [creds, setCreds] = useState<Creds | null>(() => loadCreds());
  const [state, setState] = useState<TabState | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [feed, setFeed] = useState<Array<{ at: string; name: string; text: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!creds) return;
    try {
      const [s, m, a] = await Promise.all([api.getTab(creds), api.getMetrics(creds), api.listApprovals()]);
      setState(s); setMetrics(m); setApprovals(a.filter((x) => x.tab_id === creds.tab_id)); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [creds]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!creds) return;
    const stop = api.events((name, data) => {
      const d = data as { tab_id?: string; reason?: string; rationale?: string; amount?: number; capture_id?: string; quote?: { price: number } };
      if (d.tab_id && d.tab_id !== creds.tab_id) return;
      const text =
        name === "line.added" ? `metered ${usd(d.quote?.price)}` :
        name === "line.blocked" ? `blocked ${usd(d.quote?.price)}: ${d.reason}` :
        name === "treasurer.decision" ? `treasurer: ${d.rationale}` :
        name === "settlement.completed" ? `settled ${usd(d.amount)} -> ${d.capture_id}` :
        name === "settlement.failed" ? `settlement failed: ${d.reason}` :
        name === "approval.requested" ? `approval requested for ${usd(d.quote?.price)}` : name;
      setFeed((f) => [{ at: new Date().toISOString(), name, text }, ...f].slice(0, 60));
      void refresh();
    });
    return stop;
  }, [creds, refresh]);

  if (!creds) return <Connect onConnect={(c) => { saveCreds(c); setCreds(c); }} />;

  return (
    <div className="shell">
      <header>
        <div>
          <h1>Agent Tab <span className="muted">ledger</span></h1>
          <div className="muted mono">{creds.tab_id} · gateway {metrics?.gateway ?? "…"} {state?.vault_linked ? "· vault linked" : "· no vault"} {state?.delinquent && <b className="bad">· DELINQUENT</b>} {state?.session_ended && "· session ended"}</div>
        </div>
        <div className="actions">
          <button onClick={() => void api.closeTab(creds).then(refresh)} disabled={state?.session_ended}>Close session &amp; settle</button>
          <button className="ghost" onClick={() => { saveCreds(null); setCreds(null); setState(null); }}>Switch tab</button>
        </div>
      </header>
      {error && <div className="error">{error}</div>}

      <section className="cards">
        <Card label="Spent this session" value={usd(state?.spent_session)} sub={`cap ${usd(state?.policy.session_cap)}`} />
        <Card label="Outstanding on tab" value={usd(state?.outstanding)} sub={`settles at ${usd(state?.policy.settlement_threshold)}`} />
        <Card label="Calls metered" value={String(metrics?.calls ?? 0)} sub={`${metrics?.settlements ?? 0} settlements`} />
        <Card label="Blocked by policy" value={String(metrics?.blocked ?? 0)} sub={`${metrics?.approvals ?? 0} human approvals`} />
        <Card label="Fees saved vs per-call" value={usd(metrics?.saved)} sub={`${usd(metrics?.naive_fees)} → ${usd(metrics?.tab_fees)}`} accent />
      </section>

      <section className="grid2">
        <Panel title={`Approval inbox${approvals.length ? ` (${approvals.length})` : ""}`}>
          {approvals.length === 0 ? <p className="muted">No calls waiting. Calls above {usd(state?.policy.approval_threshold)} stop here for a human.</p> :
            approvals.map((a) => (
              <div className="approval" key={a.approval_id}>
                <div><b>{usd(a.quote.price)}</b> <span className="mono muted">{a.quote.resource}</span><div className="muted small">{a.quote.merchant_id} · {time(a.created_at)}</div></div>
                <div className="actions">
                  <button onClick={() => void api.decide(a.approval_id, "approve").then(refresh)}>Approve</button>
                  <button className="ghost" onClick={() => void api.decide(a.approval_id, "deny").then(refresh)}>Deny</button>
                </div>
              </div>
            ))}
        </Panel>
        <Panel title="Fees: per-call billing vs the tab">
          <FeeChart m={metrics} />
        </Panel>
      </section>

      <Panel title="Settlements (one PayPal capture each)">
        <Grid<Settlement> rows={state?.settlements ?? []} height={180} cols={[
          { field: "at", headerName: "Time", valueFormatter: (p) => time(p.value), width: 110 },
          { field: "amount", headerName: "Amount", valueFormatter: (p) => usd(p.value), width: 100 },
          { field: "lines", headerName: "Lines", width: 80 },
          { field: "status", width: 110, cellClass: (p) => (p.value === "completed" ? "ok" : "bad") },
          { field: "capture_id", headerName: "PayPal capture", width: 200 },
          { field: "paypal_fee", headerName: "Fee", valueFormatter: (p) => usd(p.value), width: 90 },
          { field: "reason", width: 150 },
          { field: "rationale", headerName: "Treasurer rationale", flex: 1, tooltipField: "rationale" },
          { field: "llm_adjusted", headerName: "LLM", width: 70, valueFormatter: (p) => (p.value ? "early" : "") },
        ]} />
      </Panel>

      <section className="grid2">
        <Panel title="Tab lines">
          <Grid<Line> rows={state?.lines ?? []} height={260} cols={[
            { field: "created_at", headerName: "Time", valueFormatter: (p) => time(p.value), width: 110 },
            { field: "quote.price", headerName: "Price", valueFormatter: (p) => usd(p.value), width: 90 },
            { field: "quote.resource", headerName: "Resource", flex: 1 },
            { field: "approved_by_human", headerName: "Approved", width: 100, valueFormatter: (p) => (p.value ? "human" : "policy") },
          ]} />
        </Panel>
        <Panel title="Blocked attempts">
          <Grid<Blocked> rows={state?.blocked ?? []} height={260} cols={[
            { field: "at", headerName: "Time", valueFormatter: (p) => time(p.value), width: 110 },
            { field: "quote.price", headerName: "Price", valueFormatter: (p) => usd(p.value), width: 90 },
            { field: "quote.resource", headerName: "Resource", flex: 1 },
            { field: "reason", width: 180, cellClass: "bad" },
          ]} />
        </Panel>
      </section>

      <Panel title="Live feed">
        <ul className="feed">{feed.map((f, i) => <li key={i}><span className="muted mono">{time(f.at)}</span> <span className={`tag ${f.name.split(".")[0]}`}>{f.name}</span> {f.text}</li>)}</ul>
      </Panel>
    </div>
  );
}

function Grid<T>({ rows, cols, height }: { rows: T[]; cols: ColDef<T>[]; height: number }) {
  const defaultColDef = useMemo<ColDef<T>>(() => ({ sortable: true, resizable: true, filter: true }), []);
  return <div style={{ height }}><AgGridReact<T> theme={theme} rowData={rows} columnDefs={cols} defaultColDef={defaultColDef} animateRows /></div>;
}

function FeeChart({ m }: { m: Metrics | null }) {
  const options = useMemo<AgChartOptions>(() => ({
    data: [{ mode: "Per-call billing", fees: m?.naive_fees ?? 0 }, { mode: "Agent Tab", fees: m?.tab_fees ?? 0 }],
    series: [{ type: "bar", xKey: "mode", yKey: "fees", yName: "PayPal fees", fill: "#5b8cff", cornerRadius: 6 }],
    axes: [{ type: "category", position: "bottom" }, { type: "number", position: "left", label: { formatter: (p) => `$${Number(p.value).toFixed(2)}` } }],
    background: { fill: "transparent" }, theme: "ag-default-dark", height: 190,
  }), [m]);
  return <AgCharts options={options} />;
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return <div className={`card ${accent ? "accent" : ""}`}><div className="muted small">{label}</div><div className="value">{value}</div>{sub && <div className="muted small">{sub}</div>}</div>;
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}

function Connect({ onConnect }: { onConnect: (c: Creds) => void }) {
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY);
  const [vaultId, setVaultId] = useState("");
  const [existing, setExisting] = useState<Creds>({ tab_id: "", tab_token: "" });
  const [issued, setIssued] = useState<Creds | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const num = (k: keyof Policy) => ({ type: "number", step: "0.01", value: String(policy[k]), onChange: (e: ChangeEvent<HTMLInputElement>) => setPolicy({ ...policy, [k]: Number(e.target.value) }) });

  if (issued) return (
    <div className="shell narrow"><h1>Tab created</h1>
      <p>Give these to your agent (or the MCP tool) as <code>TAB_ID</code> and <code>TAB_TOKEN</code>. The token is shown once.</p>
      <pre className="mono">TAB_ID={issued.tab_id}{"\n"}TAB_TOKEN={issued.tab_token}</pre>
      <button onClick={() => onConnect(issued)}>Open ledger</button>
    </div>
  );
  return (
    <div className="shell narrow">
      <h1>Agent Tab <span className="muted">ledger</span></h1>
      <p className="muted">A bar tab for AI agents, settled through PayPal. Set the limits once; the agent can never change them.</p>
      {err && <div className="error">{err}</div>}
      <div className="panel"><h2>Create a tab</h2>
        <div className="form">
          <label>Per-call cap <input {...num("per_call_cap")} /></label>
          <label>Session cap <input {...num("session_cap")} /></label>
          <label>Daily cap <input {...num("daily_cap")} /></label>
          <label>Ask me above <input {...num("approval_threshold")} /></label>
          <label>Settle every <input {...num("settlement_threshold")} /></label>
          <label>Max calls / min <input {...num("max_calls_per_minute")} /></label>
          <label className="wide">Allowed merchants <input value={policy.merchant_allowlist.join(", ")} onChange={(e) => setPolicy({ ...policy, merchant_allowlist: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></label>
          <label className="wide">PayPal vault id (optional until Gate G1) <input value={vaultId} onChange={(e) => setVaultId(e.target.value)} placeholder="from scripts/vault-spike.ts token" /></label>
        </div>
        <button onClick={() => void api.createTab(policy, vaultId || undefined).then((c) => setIssued({ tab_id: c.tab_id, tab_token: c.tab_token })).catch((e) => setErr(String(e)))}>Create tab</button>
      </div>
      <div className="panel"><h2>Or open an existing tab</h2>
        <div className="form">
          <label className="wide">Tab id <input value={existing.tab_id} onChange={(e) => setExisting({ ...existing, tab_id: e.target.value })} /></label>
          <label className="wide">Tab token <input value={existing.tab_token} onChange={(e) => setExisting({ ...existing, tab_token: e.target.value })} /></label>
        </div>
        <button className="ghost" disabled={!existing.tab_id || !existing.tab_token} onClick={() => onConnect(existing)}>Open ledger</button>
      </div>
    </div>
  );
}
