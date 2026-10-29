import { randomUUID } from "node:crypto";

export type CaptureRequest = {
  vault_id: string;
  amount: number;
  /** Stable per settlement; used as PayPal-Request-Id so retries never double-charge. */
  reference: string;
  description: string;
};

export type CaptureResult = {
  ok: true;
  order_id: string;
  capture_id: string;
  status: string;
  paypal_fee?: number;
  raw?: unknown;
} | {
  ok: false;
  error: string;
  raw?: unknown;
};

/** The only thing the tab service needs from a payment rail. */
export interface PaymentGateway {
  readonly name: string;
  capture(req: CaptureRequest): Promise<CaptureResult>;
}

/** Deterministic stand-in used in tests and when no PayPal credentials are configured. */
export class MockGateway implements PaymentGateway {
  readonly name = "mock";
  calls: CaptureRequest[] = [];
  failNext = 0;
  constructor(private fee = (amount: number) => Math.round((0.49 + 0.0349 * amount) * 100) / 100) {}
  async capture(req: CaptureRequest): Promise<CaptureResult> {
    this.calls.push(req);
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, error: "INSTRUMENT_DECLINED" };
    }
    const id = randomUUID().slice(0, 8).toUpperCase();
    return { ok: true, order_id: `MOCK-ORD-${id}`, capture_id: `MOCK-CAP-${id}`, status: "COMPLETED", paypal_fee: this.fee(req.amount) };
  }
}

type Json = Record<string, unknown>;

/**
 * PayPal Vault v3 + Orders v2: one order per settlement, charged against a vaulted
 * payment method with merchant-initiated stored-credential flags.
 */
export class PayPalGateway implements PaymentGateway {
  readonly name = "paypal";
  private token?: { value: string; expires: number };

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(): PayPalGateway | null {
    const id = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    if (!id || !secret) return null;
    return new PayPalGateway(id, secret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json()) as Json;
    if (!res.ok) throw new Error(`paypal oauth ${res.status}: ${JSON.stringify(body)}`);
    this.token = { value: body.access_token as string, expires: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(method: "GET" | "POST", path: string, requestId: string, body?: Json): Promise<{ status: number; json: Json }> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    try {
      const created = await this.call("POST", "/v2/checkout/orders", `${req.reference}:create`, {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: req.reference, description: req.description, amount: { currency_code: "USD", value: req.amount.toFixed(2) } }],
        payment_source: {
          paypal: {
            vault_id: req.vault_id,
            stored_credential: { payment_initiator: "MERCHANT", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" },
          },
        },
      });
      if (created.status !== 200 && created.status !== 201) return { ok: false, error: `order_create_${created.status}`, raw: created.json };

      let final = created.json;
      if (final.status !== "COMPLETED") {
        const cap = await this.call("POST", `/v2/checkout/orders/${final.id}/capture`, `${req.reference}:capture`, {});
        if (cap.status !== 200 && cap.status !== 201) return { ok: false, error: `capture_${cap.status}`, raw: cap.json };
        final = cap.json;
      }
      const pu = (final.purchase_units as Json[] | undefined)?.[0];
      const capture = ((pu?.payments as Json | undefined)?.captures as Json[] | undefined)?.[0];
      if (!capture || capture.status !== "COMPLETED") return { ok: false, error: `capture_status_${capture?.status ?? "missing"}`, raw: final };
      const fee = (capture.seller_receivable_breakdown as Json | undefined)?.paypal_fee as Json | undefined;
      return {
        ok: true,
        order_id: String(final.id),
        capture_id: String(capture.id),
        status: String(capture.status),
        paypal_fee: fee ? Number(fee.value) : undefined,
        raw: final,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
