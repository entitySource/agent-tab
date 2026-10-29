import type { Advisor } from "./treasurer.js";

/**
 * Optional LLM advisor built on the Vercel AI SDK + Anthropic. Loaded lazily so the
 * service runs without an API key (template rationales only).
 */
export async function createAnthropicAdvisor(model = process.env.AGENT_TAB_MODEL ?? "claude-sonnet-5-5"): Promise<Advisor | undefined> {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");

  return async ({ input, core, fee_if_settled_now, fee_share_now }) => {
    const prompt = [
      "You are the treasurer for an AI agent's metered tab settled through PayPal.",
      "The deterministic rule has decided to HOLD. You may recommend settling EARLY only if there is a concrete risk reason",
      "(for example a burst of calls suggesting runaway spend). You cannot raise any limit.",
      `Outstanding: $${input.outstanding.toFixed(2)}. Threshold: $${input.settlement_threshold.toFixed(2)}.`,
      `Fee if settled now: $${fee_if_settled_now.toFixed(2)} (${Math.round(fee_share_now * 100)}% of the tab).`,
      `Calls in the last minute: ${input.calls_last_minute}. Open for ${Math.round((input.now.getTime() - input.open_since.getTime()) / 60000)} min of ${Math.round(input.exposure_window_ms / 60000)} allowed.`,
      `Core reason: ${core.reason}.`,
      'Reply with JSON only: {"settle_early": boolean, "rationale": "<one sentence, max 25 words>"}',
    ].join("\n");
    const { text } = await generateText({ model: anthropic(model), prompt, maxTokens: 120 });
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { settle_early?: unknown; rationale?: unknown }) : {};
    return { settle_early: parsed.settle_early === true, rationale: typeof parsed.rationale === "string" ? parsed.rationale : "" };
  };
}
