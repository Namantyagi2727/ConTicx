// A deliberately minimal in-process stand-in for the Hyperswitch REST
// API. It implements ONLY the endpoints and responses the Phase 1A
// tests exercise, and nothing else:
//
//   POST /payments            create a payment intent
//   GET  /payments/:id        retrieve one
//   POST /payments/:id/cancel cancel (success, or a 400 rejection)
//   POST /refunds             create a refund
//
// It is not a Hyperswitch simulator. Where its behavior reflects a
// documented contract that matters to a test, the comment says so and
// cites the audit; where a test needs a specific branch (a cancel that
// is rejected with 400, a refund that is still pending), the test flips
// an explicit knob rather than the fake guessing. Real provider-contract
// verification against the sandbox stays deferred (addendum S1–S10).
//
// The server binds an ephemeral port on 127.0.0.1 and records every
// request so tests can assert how the application called it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export interface StoredPayment {
  payment_id: string;
  client_secret: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  merchant_id?: string;
  profile_id?: string;
}

// Hyperswitch returns a refund status that is NOT always "succeeded"
// even on a 200 (succeeded | pending | failed | review) — documented in
// the refund API reference and central to finding INV-04. The default
// here is "succeeded" (the only case the current refund route treats as
// done); tests that care set it explicitly.
type RefundStatus = "succeeded" | "pending" | "failed" | "review";

export class FakeHyperswitch {
  readonly calls: RecordedCall[] = [];
  private readonly payments = new Map<string, StoredPayment>();
  private server: Server | null = null;
  private seq = 0;

  // Knobs the scenarios flip. Defaults mirror the common sandbox path.
  cancelRejectsWith400 = false; // INV-01: intent moved past a cancellable state
  cancelRejectionBody: unknown = {
    error: { type: "invalid_request", code: "IR_16", message: "You cannot cancel this payment because it has status succeeded" },
  };
  refundStatus: RefundStatus = "succeeded";
  // Delays every response by this many ms — used to exercise the provider
  // request timeout deterministically (set a delay above the configured
  // HYPERSWITCH_TIMEOUT_MS).
  delayMs = 0;
  // When set, GET /payments/:id replies 200 with a non-JSON body, so the
  // retrieve helper's JSON parse fails (a misbehaving-provider case).
  getReturnsNonJson = false;

  // `port` 0 binds an ephemeral port (used by the fake's own unit
  // self-test); the integration setup passes the fixed loopback port
  // that vitest's test.env already told the app to call.
  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server!.address();
    if (!address || typeof address === "string") {
      throw new Error("fake hyperswitch failed to bind a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve()))
    );
    this.server = null;
  }

  reset(): void {
    this.calls.length = 0;
    this.payments.clear();
    this.seq = 0;
    this.cancelRejectsWith400 = false;
    this.refundStatus = "succeeded";
    this.delayMs = 0;
    this.getReturnsNonJson = false;
  }

  getPayment(id: string): StoredPayment | undefined {
    return this.payments.get(id);
  }

  // Seeds a payment directly (bypassing POST /payments) so a test can set
  // up a specific retrieve result — e.g. a payment whose metadata.orderId
  // points at an order, or one carrying a particular merchant_id — without
  // going through the full create flow.
  seedPayment(p: {
    payment_id: string;
    status?: string;
    amount?: number;
    currency?: string;
    metadata?: Record<string, unknown> | null;
    merchant_id?: string;
    profile_id?: string;
  }): StoredPayment {
    const payment: StoredPayment = {
      payment_id: p.payment_id,
      client_secret: `${p.payment_id}_secret_seed`,
      status: p.status ?? "requires_payment_method",
      amount: p.amount ?? 0,
      currency: p.currency ?? "USD",
      metadata: p.metadata ?? null,
      merchant_id: p.merchant_id,
      profile_id: p.profile_id,
    };
    this.payments.set(payment.payment_id, payment);
    return payment;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body = await readJson(req);
    this.calls.push({ method, path, body });

    // Optional response delay, so a test can drive the client's request
    // timeout (the client aborts before this resolves).
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    // POST /payments
    if (method === "POST" && path === "/payments") {
      const input = (body ?? {}) as { amount?: number; currency?: string; metadata?: Record<string, unknown> };
      const id = `pay_${++this.seq}_${randomUUID().slice(0, 8)}`;
      const payment: StoredPayment = {
        payment_id: id,
        client_secret: `${id}_secret_${randomUUID().slice(0, 12)}`,
        status: "requires_payment_method",
        amount: input.amount ?? 0,
        currency: input.currency ?? "USD",
        metadata: input.metadata ?? null,
      };
      this.payments.set(id, payment);
      return json(res, 200, payment);
    }

    // POST /payments/:id/cancel
    const cancelMatch = path.match(/^\/payments\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      if (this.cancelRejectsWith400) {
        return json(res, 400, this.cancelRejectionBody);
      }
      const id = decodeURIComponent(cancelMatch[1]);
      const payment = this.payments.get(id);
      if (payment) payment.status = "cancelled";
      return json(res, 200, { payment_id: id, status: "cancelled" });
    }

    // GET /payments/:id
    const getMatch = path.match(/^\/payments\/([^/]+)$/);
    if (method === "GET" && getMatch) {
      if (this.getReturnsNonJson) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not json</html>");
        return;
      }
      const id = decodeURIComponent(getMatch[1]);
      const payment = this.payments.get(id);
      if (!payment) return json(res, 404, { error: { message: "payment not found" } });
      return json(res, 200, payment);
    }

    // POST /refunds
    if (method === "POST" && path === "/refunds") {
      const input = (body ?? {}) as { payment_id?: string; amount?: number };
      return json(res, 200, {
        refund_id: `ref_${randomUUID().slice(0, 10)}`,
        payment_id: input.payment_id ?? null,
        amount: input.amount ?? 0,
        status: this.refundStatus,
      });
    }

    return json(res, 404, { error: { message: `fake hyperswitch: unhandled ${method} ${path}` } });
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}
