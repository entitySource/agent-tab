# Demo video script (target 2:40, hard limit 3:00)

Record at 1920x1080. Left half: terminal running the agent. Right half: ledger UI in a browser.
No music. Narration only.

## Setup before recording

```bash
npm run dev:tab & npm run dev:api & npm run dev:ledger
```

Open http://localhost:4300. If PayPal credentials are configured, create the tab with the
`vault_id` from the spike so settlements show real sandbox capture ids.

## Beats

| Time | Say | Show |
|---|---|---|
| 0:00 | "AI agents are starting to buy things. Today you either hand an agent your PayPal credentials, or you make it pay per call. The first has no limit and no audit trail. The second loses money: PayPal's fixed fee is about forty-nine cents, so a two-cent API call costs fifty-one." | Title card, then two lines of fee math |
| 0:25 | "Agent Tab is a bar tab for AI agents, settled through PayPal. You set the limits once. The agent orders. A treasurer decides when to swipe the card." | Analogy card |
| 0:40 | "The human creates the tab: thirty cents per call, five dollars a session, ask me above twenty cents, settle every dollar. The payment method is vaulted once with PayPal Vault. The agent gets a token, never a credential." | Ledger: Create tab form → token shown once |
| 1:05 | "A research agent starts working. Every call comes back as HTTP 402 with a price. The client puts it on the tab, gets a signed receipt, and retries. Watch the lines fill." | Split screen: agent terminal + Tab lines grid + live feed |
| 1:30 | "A twenty-five cent summary is above the approval threshold, so it stops here." Click Approve. "The agent resumes." | Approval inbox → Approve |
| 1:45 | "Now the agent tries a nine-dollar export. Blocked: over the per-call cap. The policy lives outside the model, so no prompt can change it." | Blocked attempts grid, red reason |
| 2:00 | "The treasurer has been holding: settling eighty cents now would cost fifty-two cents in fees. When the session closes, it settles once." Click Close session. | Settlements grid: one row, capture id, fee, rationale |
| 2:20 | "Eight calls. One PayPal capture. Fees: three dollars ninety-three if billed per call, fifty-two cents on the tab." | Fee chart + saved card |
| 2:30 | "PayPal Vault v3 and Orders v2 for money. AG Grid and AG Charts for the ledger. Render for hosting. MCP so any agent can use it. Open source, Apache 2." | Stack card with repo URL |

## Fallbacks

- If the live run misbehaves, use the pre-recorded clip from the scripted agent (`AGENT_MODE=scripted`).
- If PayPal is unavailable, state on screen that the gateway is the mock and show `.spike/log.jsonl` from the passed G1 run.
