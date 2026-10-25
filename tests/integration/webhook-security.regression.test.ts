import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as webhook } from "@/app/api/webhooks/hyperswitch/route";
import { updateOrderStatus } from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { failRedisCommand } from "../helpers/faults";
import { makeTestRedis } from "../helpers/redis";
import { createOwnedOrder } from "../helpers/guest";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";
import {
  TEST_HYPERSWITCH_BASE_URL,
  TEST_HYPERSWITCH_WEBHOOK_SECRET,
  TEST_REDIS_URL,
} from "../setup/constants";

// REGRESSION — Phase 1B.2: fail-closed Hyperswitch webhook authentication,
// payment-to-order binding, justified transitions, and delivery dedup. All
// against the local fake provider + Redis adapter. Signature vectors are
// produced by an INDEPENDENT signer (tests/helpers/webhook), never by the
// route's own verifier.

const SECRET = TEST_HYPERSWITCH_WEBHOOK_SECRET;
const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const r = makeTestRedis();

afterEach(() => {
  // Re-assert the env a test may have perturbed, so other tests are clean.
  // (globalThis.fetch is restored by the integration setup's own afterEach,
  // which reinstalls the loopback guard.)
  process.env.HYPERSWITCH_WEBHOOK_SECRET = SECRET;
  delete process.env.HYPERSWITCH_MERCHANT_ID;
  delete process.env.HYPERSWITCH_TIMEOUT_MS;
});

// Orders are created by a guest through the real order route (Phase 1B.4);
// webhook processing itself never involves a guest cookie.
async function createOrder(quantity = 1): Promise<{ orderId: string; paymentId: string }> {
  const { orderId, paymentId } = await createOwnedOrder(undefined, quantity);
  return { orderId, paymentId };
}

function bodyFor(
  paymentId: string,
  opts: { eventId?: string; eventType?: string } = {}
): string {
  return JSON.stringify({
    merchant_id: "merchant_test",
    event_id: opts.eventId ?? `evt_${randomUUID()}`,
    event_type: opts.eventType ?? "payment_succeeded",
    content: { type: "payment_details", object: { payment_id: paymentId, metadata: {} } },
    timestamp: new Date().toISOString(),
  });
}

function signed(rawBody: string): Request {
  return makeWebhookRequest(rawBody, signWebhookBody(rawBody, SECRET));
}

async function statusOf(orderId: string): Promise<string> {
  return (await r.get<Order>(`order:${orderId}`))!.status;
}

async function counter(): Promise<number> {
  return (await r.get<number>(INV_KEY))!;
}

function getPaymentReads(): number {
  return getFake().calls.filter((c) => c.method === "GET" && c.path.startsWith("/payments/")).length;
}

// Counts outbound requests to the local Redis adapter and the fake provider
// by host, so a test can assert "zero Redis / zero provider calls".
function installRequestCounter(): { redis: number; provider: number; dispose: () => void } {
  const previous = globalThis.fetch;
  const redisHost = new URL(TEST_REDIS_URL).host;
  const providerHost = new URL(TEST_HYPERSWITCH_BASE_URL).host;
  const counts = {
    redis: 0,
    provider: 0,
    dispose: () => {
      globalThis.fetch = previous;
    },
  };
  const wrapped: typeof fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    try {
      const host = new URL(url).host;
      if (host === redisHost) counts.redis += 1;
      else if (host === providerHost) counts.provider += 1;
    } catch {
      /* ignore unparseable */
    }
    return previous(input as Parameters<typeof fetch>[0], init);
  };
  globalThis.fetch = wrapped;
  return counts;
}

// ---------------------------------------------------------------------------

describe("[regression] webhook signature verification (fail-closed)", () => {
  it("accepts a valid signature over the exact raw bytes and marks succeeded once", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const before = await counter();

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("succeeded");
    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(before); // succeeded keeps the seat
  });

  it("rejects a missing signature header with 401 and no change", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";

    const res = await webhook(makeWebhookRequest(bodyFor(paymentId)));

    expect(res.status).toBe(401);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects a malformed (non-hex) signature with 401", async () => {
    const { paymentId } = await createOrder();
    const res = await webhook(makeWebhookRequest(bodyFor(paymentId), "z".repeat(128)));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-length signature with 401", async () => {
    const { paymentId } = await createOrder();
    const res = await webhook(makeWebhookRequest(bodyFor(paymentId), "ab".repeat(20)));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid-hex signature of the right length with 401", async () => {
    const { paymentId } = await createOrder();
    // 128 chars but contains a non-hex 'g'.
    const res = await webhook(makeWebhookRequest(bodyFor(paymentId), "g".repeat(128)));
    expect(res.status).toBe(401);
  });

  it("rejects a correctly-formatted but incorrect signature with 401", async () => {
    const { orderId, paymentId } = await createOrder();
    const body = bodyFor(paymentId);
    // Valid format, wrong key.
    const wrong = signWebhookBody(body, "not_the_secret");
    const res = await webhook(makeWebhookRequest(body, wrong));
    expect(res.status).toBe(401);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("returns 503 when the signing secret is not configured, with no change", async () => {
    const { orderId, paymentId } = await createOrder();
    delete process.env.HYPERSWITCH_WEBHOOK_SECRET;

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(503);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects body tampering: a signature for the original body fails on an altered body", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const original = bodyFor(paymentId, { eventId: "evt_tamper" });
    const signature = signWebhookBody(original, SECRET);
    // Send a DIFFERENT body under the original signature.
    const tampered = bodyFor(paymentId, { eventId: "evt_tamper_changed" });

    const res = await webhook(makeWebhookRequest(tampered, signature));

    expect(res.status).toBe(401);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects a whitespace change: re-serialized JSON breaks the byte-exact signature", async () => {
    const { paymentId } = await createOrder();
    const compact = bodyFor(paymentId, { eventId: "evt_ws" });
    const signature = signWebhookBody(compact, SECRET);
    // Same logical JSON, extra whitespace -> different bytes.
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);

    const res = await webhook(makeWebhookRequest(pretty, signature));

    expect(res.status).toBe(401);
  });

  it("invalid authentication performs zero Redis and zero provider calls", async () => {
    const { paymentId } = await createOrder();
    const reqs = installRequestCounter();
    try {
      const res = await webhook(makeWebhookRequest(bodyFor(paymentId))); // no signature
      expect(res.status).toBe(401);
      expect(reqs.redis).toBe(0);
      expect(reqs.provider).toBe(0);
    } finally {
      reqs.dispose();
    }
  });
});

describe("[regression] webhook payload validation (after authentication)", () => {
  it("rejects authenticated malformed JSON with 400", async () => {
    const raw = "{not valid json";
    const res = await webhook(makeWebhookRequest(raw, signWebhookBody(raw, SECRET)));
    expect(res.status).toBe(400);
  });

  it("rejects an authenticated payload missing event_id with 400", async () => {
    const raw = JSON.stringify({
      event_type: "payment_succeeded",
      content: { object: { payment_id: "pay_x" } },
    });
    const res = await webhook(makeWebhookRequest(raw, signWebhookBody(raw, SECRET)));
    expect(res.status).toBe(400);
  });

  it("rejects an authenticated payload with an invalid payment id shape with 400", async () => {
    const raw = JSON.stringify({
      event_id: "evt_1",
      event_type: "payment_succeeded",
      content: { object: { payment_id: "../../etc/passwd" } },
    });
    const res = await webhook(makeWebhookRequest(raw, signWebhookBody(raw, SECRET)));
    expect(res.status).toBe(400);
  });

  it("acknowledges an authenticated unsupported (refund) event with 200 and no mutation", async () => {
    const { orderId, paymentId } = await createOrder();
    const raw = JSON.stringify({
      event_id: "evt_refund",
      event_type: "refund_succeeded",
      content: { object: { payment_id: paymentId } },
    });
    const res = await webhook(makeWebhookRequest(raw, signWebhookBody(raw, SECRET)));
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("unsupported_event");
    expect(await statusOf(orderId)).toBe("pending");
  });
});

describe("[regression] payment-to-order binding", () => {
  it("rejects a returned payment-id mismatch with 422 and no mutation", async () => {
    const { paymentId } = await createOrder();
    // Make the provider return a payment_id different from the requested one.
    getFake().getPayment(paymentId)!.payment_id = "pay_someone_else";

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(422);
  });

  it("rejects an order-association mismatch (order points at a different payment) with 422", async () => {
    const { orderId } = await createOrder();
    // A seeded payment whose metadata points at our order, but our order's
    // stored paymentId is a different payment.
    getFake().seedPayment({
      payment_id: "pay_rogue",
      status: "succeeded",
      amount: 11000,
      currency: "USD",
      metadata: { orderId },
    });

    const res = await webhook(signed(bodyFor("pay_rogue")));

    expect(res.status).toBe(422);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects an amount mismatch with 422 and no mutation", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.amount = 9999; // != stored amountCents

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(422);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects a currency mismatch with 422 and no mutation", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.currency = "EUR"; // stored is USD

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(422);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects a merchant mismatch with 422 when a merchant id is configured", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.merchant_id = "merchant_wrong";
    process.env.HYPERSWITCH_MERCHANT_ID = "merchant_expected";

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(422);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("rejects a provider response MISSING the merchant id when one is configured (422)", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    expect(getFake().getPayment(paymentId)!.merchant_id).toBeUndefined();
    process.env.HYPERSWITCH_MERCHANT_ID = "merchant_expected";

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(422);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("returns a retryable 503 for an early webhook before the payment id is attached", async () => {
    // Order exists (seeded through the atomic store) but has no paymentId
    // yet — the create -> attach window. Build that state directly.
    const orderId = randomUUID();
    const { reserveAndCreateOrder } = await import("@/lib/store");
    const order: Order = {
      id: orderId,
      eventId: EVENT_ID,
      tierName: TIER,
      quantity: 1,
      unitPriceCents: 10000,
      feeCents: 1000,
      amountCents: 11000,
      currency: "USD",
      status: "pending",
      holdExpiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now(),
      ownerHash: "a".repeat(64), // Phase 1B.4: every new order has an owner
      attemptId: randomUUID(), // Phase 1B.5: and a booking attempt
      paymentRequestId: "pay_" + "b".repeat(26), // and a provider payment identity
    };
    expect(await reserveAndCreateOrder(order, 10)).toBe("created");
    getFake().seedPayment({
      payment_id: "pay_early",
      status: "succeeded",
      amount: 11000,
      currency: "USD",
      metadata: { orderId },
    });

    const eventId = "evt_early";
    const res = await webhook(signed(bodyFor("pay_early", { eventId })));

    expect(res.status).toBe(503);
    expect(await statusOf(orderId)).toBe("pending"); // no mutation
    expect(await r.exists(`webhook_event:${eventId}`)).toBe(0); // no marker
  });
});

describe("[regression] justified transitions from authoritative status", () => {
  it("does not mark succeeded when the provider reports a different (non-terminal) state", async () => {
    const { orderId, paymentId } = await createOrder();
    // Event NAME says succeeded, but the authoritative provider state is not.
    getFake().getPayment(paymentId)!.status = "processing";
    const eventId = "evt_name_vs_state";

    const res = await webhook(signed(bodyFor(paymentId, { eventId, eventType: "payment_succeeded" })));

    expect(res.status).toBe(503); // ambiguous/non-terminal -> retryable
    expect(await statusOf(orderId)).toBe("pending"); // no transition
    expect(await r.exists(`webhook_event:${eventId}`)).toBe(0); // no marker
  });

  it("marks a verified success exactly once and treats a sequential redelivery as a duplicate", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const body = bodyFor(paymentId, { eventId: "evt_once" });
    const before = await counter();

    const first = await webhook(signed(body));
    expect(first.status).toBe(200);
    expect(await statusOf(orderId)).toBe("succeeded");
    const readsAfterFirst = getPaymentReads();

    const second = await webhook(signed(body)); // same event id
    expect(second.status).toBe(200);
    expect((await second.json()).reason).toBe("duplicate");
    expect(getPaymentReads()).toBe(readsAfterFirst); // no second provider read
    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(before); // still a single (no-release) effect
  });

  it("retains inventory on a failed payment (failed may be retried) and acknowledges", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "failed";
    const before = await counter();

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("failed_retained");
    expect(await statusOf(orderId)).toBe("pending"); // not released
    expect(await counter()).toBe(before); // inventory NOT returned
  });

  it("releases inventory on a cancelled (terminal, unpaid) payment", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "cancelled";
    const afterReserve = await counter();

    const res = await webhook(signed(bodyFor(paymentId)));

    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1); // seat released once
  });

  it("does not overwrite a resolved terminal order when a late success conflicts", async () => {
    const { orderId, paymentId } = await createOrder();
    // The hold was reaped as expired before the success webhook arrives.
    await updateOrderStatus(orderId, "expired");
    expect(await statusOf(orderId)).toBe("expired");
    const afterExpire = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const eventId = "evt_late_success";

    const res = await webhook(signed(bodyFor(paymentId, { eventId })));

    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("conflict");
    expect(await statusOf(orderId)).toBe("expired"); // NOT overwritten to succeeded
    expect(await counter()).toBe(afterExpire); // no inventory change
  });
});

describe("[regression] duplicate delivery and provider/infra failures", () => {
  it("applies the inventory effect exactly once for concurrent duplicate deliveries", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "cancelled";
    const afterReserve = await counter();
    const body = bodyFor(paymentId, { eventId: "evt_concurrent" });

    const [a, b] = await Promise.all([webhook(signed(body)), webhook(signed(body))]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1); // released once, not twice
  });

  it("does not repeat the inventory effect when reprocessing after a lost completion marker", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "cancelled";
    const afterReserve = await counter();
    const body = bodyFor(paymentId, { eventId: "evt_lost_response" });

    // Simulate a crash after the transition but before the marker write:
    // fail the marker SET (which carries "SET" + the webhook_event key),
    // NOT the earlier EXISTS dedup check (which carries no "SET").
    const dispose = failRedisCommand(
      (b) => b.includes('"SET"') && b.includes("WEBHOOK_EVENT:")
    );
    let first: Response;
    try {
      first = await webhook(signed(body));
    } finally {
      dispose();
    }
    expect(first.status).toBe(503); // marker write failed -> retryable
    expect(await statusOf(orderId)).toBe("failed"); // transition DID apply
    expect(await counter()).toBe(afterReserve + 1); // released once
    expect(await r.exists("webhook_event:evt_lost_response")).toBe(0); // no marker

    const second = await webhook(signed(body)); // redelivery
    expect(second.status).toBe(200);
    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1); // STILL released only once
  });

  it("returns a retryable 503 and no marker on a provider timeout", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().delayMs = 300;
    process.env.HYPERSWITCH_TIMEOUT_MS = "50";
    const eventId = "evt_timeout";

    const res = await webhook(signed(bodyFor(paymentId, { eventId })));

    expect(res.status).toBe(503);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await r.exists(`webhook_event:${eventId}`)).toBe(0);
  });

  it("returns a retryable 503 and no marker on a non-JSON provider response", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getReturnsNonJson = true;
    const eventId = "evt_nonjson";

    const res = await webhook(signed(bodyFor(paymentId, { eventId })));

    expect(res.status).toBe(503);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await r.exists(`webhook_event:${eventId}`)).toBe(0);
  });

  it("returns a retryable 503 and no marker when the atomic transition hits a Redis failure", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const before = await counter();
    const eventId = "evt_redis_down";
    // The transition's EVAL rejects; everything before it (exists / get /
    // provider) succeeds, so this isolates the transition failure.
    const dispose = failRedisCommand((b) => b.includes('"EVAL"'));
    let res: Response;
    try {
      res = await webhook(signed(bodyFor(paymentId, { eventId })));
    } finally {
      dispose();
    }

    expect(res.status).toBe(503);
    expect(await statusOf(orderId)).toBe("pending"); // unchanged
    expect(await counter()).toBe(before);
    expect(await r.exists(`webhook_event:${eventId}`)).toBe(0);
  });
});
