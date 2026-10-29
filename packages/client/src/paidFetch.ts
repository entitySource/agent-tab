import { Quote } from "@agent-tab/shared";

export class TabDeniedError extends Error {
  constructor(public readonly reason: string, public readonly quote?: Quote) {
    super(`tab denied: ${reason}`);
    this.name = "TabDeniedError";
  }
}

export type TabClientOptions = {
  tabServiceUrl: string;
  tabId: string;
  tabToken: string;
  fetchImpl?: typeof fetch;
  /** Called when a human must approve a line. The client then polls for the decision. */
  onApprovalNeeded?: (info: { approval_id: string; quote: Quote }) => void;
  approvalTimeoutMs?: number;
  approvalPollMs?: number;
};

export type PaidFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Wraps fetch. On HTTP 402 it asks the tab service to add the quoted line to the tab
 * (the tab service enforces policy and signs a receipt), then retries with the receipt.
 * The agent never sees a payment credential; it only ever holds short-lived receipts.
 */
export function createTabClient(opts: TabClientOptions): PaidFetch {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.tabServiceUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${opts.tabToken}`, "content-type": "application/json" };
  const timeout = opts.approvalTimeoutMs ?? 60_000;
  const poll = opts.approvalPollMs ?? 500;

  async function waitForApproval(approvalId: string): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const r = await f(`${base}/approvals/${approvalId}`, { headers });
      const body = (await r.json()) as { status: string; receipt?: string; reason?: string };
      if (body.status === "approved" && body.receipt) return body.receipt;
      if (body.status === "denied") throw new TabDeniedError(body.reason ?? "denied_by_human");
      await new Promise((res) => setTimeout(res, poll));
    }
    throw new TabDeniedError("approval_timeout");
  }

  return async function paidFetch(input, init) {
    const first = await f(input, init);
    if (first.status !== 402) return first;

    const body = (await first.json()) as { quote?: unknown };
    const quote = Quote.parse(body.quote);

    const lineRes = await f(`${base}/tabs/${opts.tabId}/lines`, {
      method: "POST",
      headers,
      body: JSON.stringify({ quote }),
    });

    let receipt: string;
    if (lineRes.status === 201) {
      receipt = ((await lineRes.json()) as { receipt: string }).receipt;
    } else if (lineRes.status === 202) {
      const { approval_id } = (await lineRes.json()) as { approval_id: string };
      opts.onApprovalNeeded?.({ approval_id, quote });
      receipt = await waitForApproval(approval_id);
    } else {
      const err = (await lineRes.json().catch(() => ({}))) as { reason?: string };
      throw new TabDeniedError(err.reason ?? `tab_service_${lineRes.status}`, quote);
    }

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("authorization", `Tab ${receipt}`);
    return f(input, { ...init, headers: retryHeaders });
  };
}
