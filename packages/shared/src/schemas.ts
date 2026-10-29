import { z } from "zod";

/** A price quote returned by a seller alongside HTTP 402. */
export const Quote = z.object({
  quote_id: z.string().min(1),
  merchant_id: z.string().min(1),
  price: z.number().positive(),
  currency: z.literal("USD"),
  resource: z.string().min(1),
  expires_at: z.string().datetime(),
});
export type Quote = z.infer<typeof Quote>;

/** Human-set limits. The agent can never change these. */
export const Policy = z.object({
  per_call_cap: z.number().positive(),
  session_cap: z.number().positive(),
  daily_cap: z.number().positive(),
  merchant_allowlist: z.array(z.string().min(1)).min(1),
  approval_threshold: z.number().nonnegative(),
  settlement_threshold: z.number().positive(),
  max_calls_per_minute: z.number().int().positive(),
  expires_at: z.string().datetime(),
});
export type Policy = z.infer<typeof Policy>;

/** One metered item on a tab. */
export const TabLine = z.object({
  line_id: z.string().min(1),
  tab_id: z.string().min(1),
  quote: Quote,
  created_at: z.string().datetime(),
  approved_by_human: z.boolean().default(false),
});
export type TabLine = z.infer<typeof TabLine>;

/** Signed proof that a line was added to a tab; presented to the seller on retry. */
export const ReceiptClaims = z.object({
  line_id: z.string(),
  tab_id: z.string(),
  quote_id: z.string(),
  merchant_id: z.string(),
  price: z.number(),
  nonce: z.string(),
});
export type ReceiptClaims = z.infer<typeof ReceiptClaims>;
