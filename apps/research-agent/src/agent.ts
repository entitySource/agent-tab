import { z } from "zod";
import { TabDeniedError, type PaidFetch } from "@agent-tab/client";

export type Step = { tool: string; args: Record<string, unknown>; outcome: "ok" | "denied"; detail?: string };

export type ResearchResult = { report: string; steps: Step[] };

type SearchHit = { id: string; topic: string; title: string; published: string };
type Doc = SearchHit & { body: string };
type Summary = { topic: string; count: number; headline: string; sources: string[] };

/** Thin typed wrappers over the paid API. Every call goes through the tab. */
export function makeTools(paidFetch: PaidFetch, apiUrl: string, steps: Step[]) {
  const base = apiUrl.replace(/\/$/, "");
  async function call<T>(tool: string, path: string, args: Record<string, unknown>): Promise<T | { denied: string }> {
    try {
      const res = await paidFetch(`${base}${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      steps.push({ tool, args, outcome: "ok" });
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof TabDeniedError) {
        steps.push({ tool, args, outcome: "denied", detail: err.reason });
        return { denied: err.reason };
      }
      throw err;
    }
  }
  return {
    search: (q: string) => call<{ results: SearchHit[] }>("search", `/v1/search?q=${encodeURIComponent(q)}`, { q }),
    getDoc: (id: string) => call<Doc>("get_doc", `/v1/docs/${encodeURIComponent(id)}`, { id }),
    getSummary: (topic: string) => call<Summary>("get_summary", `/v1/summary/${encodeURIComponent(topic)}`, { topic }),
    exportAll: () => call<{ docs: Doc[] }>("export_dataset", `/v1/export`, {}),
  };
}

const isDenied = (x: unknown): x is { denied: string } => typeof x === "object" && x !== null && "denied" in x;

/**
 * Scripted mode: a fixed research plan with no LLM. Used in tests and when no
 * ANTHROPIC_API_KEY is configured, so the demo always runs.
 */
export async function runScripted(question: string, tools: ReturnType<typeof makeTools>, steps: Step[]): Promise<ResearchResult> {
  const terms = question.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  const stop = new Set(["what", "does", "with", "that", "this", "from", "about", "when", "have", "will", "should", "which", "agents", "agent", "money", "lose", "state"]);
  const keywords = [...new Set(terms.filter((t) => !stop.has(t)))].slice(0, 3);
  if (keywords.length === 0) keywords.push("agentic");

  const hits = new Map<string, SearchHit>();
  for (const k of keywords) {
    const r = await tools.search(k);
    if (!isDenied(r)) for (const h of r.results) hits.set(h.id, h);
  }
  const docs: Doc[] = [];
  for (const h of [...hits.values()].slice(0, 5)) {
    const d = await tools.getDoc(h.id);
    if (!isDenied(d)) docs.push(d);
  }
  const topicCounts = new Map<string, number>();
  for (const d of docs) topicCounts.set(d.topic, (topicCounts.get(d.topic) ?? 0) + 1);
  const topTopic = [...topicCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const summary = topTopic ? await tools.getSummary(topTopic) : undefined;

  // The agent "wants" everything; the tab says no. This is the block judges should see.
  const exp = await tools.exportAll();

  const lines: string[] = [];
  lines.push(`# Research brief: ${question}`, "");
  lines.push(`Searched for: ${keywords.map((k) => `"${k}"`).join(", ")}. Read ${docs.length} documents.`, "");
  if (summary && !isDenied(summary)) lines.push(`## Topic summary: ${summary.topic}`, "", summary.headline, "");
  else if (summary && isDenied(summary)) lines.push(`## Topic summary`, "", `Not purchased: the tab denied it (${summary.denied}).`, "");
  lines.push("## Findings", "");
  for (const d of docs) lines.push(`- **${d.title}** (${d.published}, ${d.topic}): ${d.body}`);
  lines.push("", "## Sources", "", ...docs.map((d) => `- ${d.id}: ${d.title}`));
  lines.push("", "## Notes", "");
  lines.push(isDenied(exp) ? `- A full dataset export was attempted and blocked by the spending policy (${exp.denied}).` : "- Full dataset export was purchased.");
  return { report: lines.join("\n"), steps };
}

/** LLM mode: Claude plans the research itself, paying through the tab per call. */
export async function runWithModel(question: string, tools: ReturnType<typeof makeTools>, steps: Step[], model: string): Promise<ResearchResult> {
  const { generateText, tool } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");

  const t = {
    search: tool({ description: "Search the paid research dataset. Costs $0.05 per call.", parameters: z.object({ q: z.string() }), execute: ({ q }) => tools.search(q) }),
    get_doc: tool({ description: "Read one document by id. Costs $0.10 per call.", parameters: z.object({ id: z.string() }), execute: ({ id }) => tools.getDoc(id) }),
    get_summary: tool({ description: "Topic summary. Costs $0.25; may require human approval.", parameters: z.object({ topic: z.string() }), execute: ({ topic }) => tools.getSummary(topic) }),
    export_dataset: tool({ description: "Download the whole dataset. Costs $9.00.", parameters: z.object({}), execute: () => tools.exportAll() }),
  };

  const { text } = await generateText({
    model: anthropic(model),
    system: [
      "You are a research agent. Every tool call costs real money and is metered on a tab with a spending policy you cannot change.",
      "If a tool returns {denied: reason}, do not retry it; mention it in the notes.",
      "Work efficiently: search once or twice, read the most relevant 3-5 documents, optionally get one topic summary.",
      "Finish with a Markdown report: title, findings as bullets with dates, a Sources section listing document ids, and a Notes section.",
    ].join(" "),
    prompt: `Research question: ${question}`,
    tools: t,
    maxSteps: 12,
  });
  return { report: text, steps };
}
