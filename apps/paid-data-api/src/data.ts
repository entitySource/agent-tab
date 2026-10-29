export type Doc = { id: string; topic: string; title: string; body: string; published: string };

/** Tiny seeded "research dataset" the demo seller charges for. */
export const DOCS: Doc[] = [
  { id: "d1", topic: "agentic-commerce", title: "AP2 v0.2 adds human-not-present mandates", body: "Google donated AP2 to the FIDO Alliance in April 2026; v0.2 supports pre-authorized autonomous payments.", published: "2026-04-28" },
  { id: "d2", topic: "agentic-commerce", title: "PayPal enables WebMCP for Store Sync merchants", body: "Benchmarks: three structured tool calls instead of 30+ UI steps; roughly 2x faster and 4.6x cheaper inference.", published: "2026-09-16" },
  { id: "d3", topic: "agentic-commerce", title: "Shopify ships WebMCP checkout tools", body: "navigate_to_storefront, get_checkout, update_checkout, complete_checkout; the buyer still confirms the order.", published: "2026-09-30" },
  { id: "d4", topic: "payments-fees", title: "PayPal fixed fee per capture", body: "US commercial transactions carry a fixed fee per capture plus a percentage; the fixed component dominates on sub-dollar amounts.", published: "2026-01-10" },
  { id: "d5", topic: "payments-fees", title: "Why per-call billing loses money", body: "A $0.02 API call settled individually pays more in fixed fees than it earns; batching into a tab restores margin.", published: "2026-03-02" },
  { id: "d6", topic: "x402", title: "x402 facilitators and the bazaar", body: "Coinbase and PayAI expose discovery catalogs; settlement is in USDC on Base or Solana.", published: "2026-02-14" },
  { id: "d7", topic: "x402", title: "Limits of crypto-only agent payments", body: "Most businesses cannot hold stablecoins; fiat rails with spend policy are the missing piece.", published: "2026-05-20" },
  { id: "d8", topic: "merchant-pain", title: "Dispute fee economics", body: "Fees are waived when a dispute is resolved before escalation; response windows are 10 days, 3 for high-volume sellers.", published: "2026-06-11" },
  { id: "d9", topic: "merchant-pain", title: "New-seller holds", body: "Funds release about 24 hours after carrier-confirmed delivery or 7 days after a digital order is marked complete.", published: "2026-07-01" },
  { id: "d10", topic: "merchant-pain", title: "Reconciliation gaps", body: "Netted fees, folded refunds and FX mean deposits never match sales without a per-order ledger.", published: "2026-08-19" },
];

export function search(q: string): Array<Pick<Doc, "id" | "topic" | "title" | "published">> {
  const needle = q.toLowerCase();
  return DOCS.filter((d) => [d.topic, d.title, d.body].some((s) => s.toLowerCase().includes(needle))).map(({ id, topic, title, published }) => ({ id, topic, title, published }));
}

export function summary(topic: string): { topic: string; count: number; headline: string; sources: string[] } | null {
  const docs = DOCS.filter((d) => d.topic === topic);
  if (!docs.length) return null;
  return { topic, count: docs.length, headline: docs.map((d) => d.title).join("; "), sources: docs.map((d) => d.id) };
}
