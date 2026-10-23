import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as webhook } from "@/app/api/webhooks/hyperswitch/route";
import { HOLD_EXPIRY_BATCH_SIZE } from "@/lib/constants";
import {
  getOrder,
  getReconciliationFlag,
  markPaymentAttempt,
  reserveAndCreateOrder,
} from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";
import { TEST_HYPERSWITCH_WEBHOOK_SECRET } from "../setup/constants";

// REGRESSION — Phase 1B.3: authoritative, bounded hold expiry.
//
// Converted from the INV-01 characterization, which pinned the DEFECT that
// an expired hold whose cancel was rejected with HTTP 400 was marked
// "succeeded" and kept its seat. Expiry now resolves every hold from the
// AUTHORITATIVE provider status (retrieve -> bind -> shared decision), gives
// a still-cancellable payment ONE cancellation attempt followed by a re-read,
// and never derives succeeded or released from an HTTP response code.
// Inconclusive outcomes retain the allocation and are flagged.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const r = makeTestRedis();

afterEach(() => {
  delete process.env.HYPERSWITCH_TIMEOUT_MS;
});

async function createOrder(): Promise<{ orderId: string; paymentId: string }> {
  const res = await createOrderRoute(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: EVENT_ID, tierName: TIER, quantity: 1 }),
    })
  );
  if (res.status !== 200) throw new Error(`order setup failed: ${res.status}`);
  const data = await res.json();
  return { orderId: data.orderId, paymentId: data.paymentId };
}

// Push an order's hold into the past and re-score its index entry so the
// next lazy-expiry pass selects it.
async function expireHold(orderId: string): Promise<void> {
  const order = (await r.get<Order>(`order:${orderId}`))!;
  const past = Date.now() - 60_000;
  order.holdExpiresAt = past;
  await r.set(`order:${orderId}`, order);
  await r.zadd("pending_holds", { score: past, member: orderId });
}

// Any store read runs one lazy-expiry pass.
async function runExpiryPass(): Promise<void> {
  await getOrder(`probe-${randomUUID()}`);
}

async function statusOf(orderId: string): Promise<string> {
  return (await r.get<Order>(`order:${orderId}`))!.status;
}

async function counter(key = INV_KEY): Promise<number> {
  return Number(await r.get<number>(key));
}

async function inIndex(orderId: string): Promise<boolean> {
  return (await r.zscore("pending_holds", orderId)) !== null;
}

function cancelCalls(): number {
  return getFake().calls.filter((c) => c.path.endsWith("/cancel")).length;
}

// ---------------------------------------------------------------------------

describe("[regression] INV-01: a cancellation response never decides the outcome", () => {
  it("cancel 400 followed by an authoritative 'succeeded' marks paid and releases nothing", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "processing"; // looks cancellable
    getFake().cancelRejectsWith400 = true;
    getFake().statusAfterCancel400 = "succeeded"; // it just moved on
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("succeeded"); // from the re-read, not the 400
    expect(await counter()).toBe(afterReserve); // seat kept
  });

  it("cancel 400 followed by 'failed' retains the seat, flags it, and never marks paid", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "processing";
    getFake().cancelRejectsWith400 = true;
    getFake().statusAfterCancel400 = "failed";
    await expireHold(orderId);

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending"); // retained, not succeeded
    expect(await counter()).toBe(afterReserve); // not released either
    expect((await getReconciliationFlag(orderId))?.reason).toBe("payment_failed_retryable");
    expect(await inIndex(orderId)).toBe(false); // stops reprocessing
  });

  it("cancel 400 with the payment still processing retains, flags, and never marks paid", async () => {
    // The original INV-01 scenario: before Phase 1B.3 this became 'succeeded'.
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "processing";
    getFake().cancelRejectsWith400 = true; // status unchanged by the 400
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("cancel_then_not_final");
    expect(await inIndex(orderId)).toBe(false);
  });
});

describe("[regression] confirmed provider finality releases exactly once", () => {
  it("a successful cancellation confirmed by the re-read releases the seat once", async () => {
    const { orderId } = await createOrder(); // status requires_payment_method
    const afterReserve = await counter();
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1);
  });

  it("a payment the provider already reports 'expired' is released without a cancel", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "expired";
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(0);
    expect(await statusOf(orderId)).toBe("expired");
    expect(await counter()).toBe(afterReserve + 1);
  });

  it("two expiry passes over the same hold release at most once (sequential and concurrent)", async () => {
    const { orderId } = await createOrder();
    const afterReserve = await counter();
    await expireHold(orderId);

    await Promise.all([runExpiryPass(), runExpiryPass()]);
    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1); // never +2
    expect(cancelCalls()).toBe(1);
  });
});

describe("[regression] inconclusive evidence retains the allocation", () => {
  it("cancellation succeeded but the re-read is inconclusive: retained and flagged", async () => {
    const { orderId } = await createOrder();
    const afterReserve = await counter();
    getFake().getFailsAfterCancel = true; // first read fine, re-read 500s
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe(
      "cancel_issued_retrieve_inconclusive"
    );
    // Kept in the index so a later pass can confirm once the provider answers.
    expect(await inIndex(orderId)).toBe(true);
  });

  for (const [label, setup] of [
    ["non-JSON", () => (getFake().getReturnsNonJson = true)],
    ["5xx", () => (getFake().getReturns500 = true)],
    [
      "timeout",
      () => {
        getFake().delayMs = 300;
        process.env.HYPERSWITCH_TIMEOUT_MS = "50";
      },
    ],
  ] as const) {
    it(`a ${label} provider read guesses no terminal outcome and makes no cancel`, async () => {
      const { orderId } = await createOrder();
      const afterReserve = await counter();
      await expireHold(orderId);
      setup();

      await runExpiryPass();

      expect(cancelCalls()).toBe(0);
      expect(await statusOf(orderId)).toBe("pending");
      expect(await counter()).toBe(afterReserve);
      expect(await inIndex(orderId)).toBe(true); // transient: retried next pass
    });
  }

  it("a binding mismatch guesses no terminal outcome; retained and flagged", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.amount = 1; // != stored amountCents
    await expireHold(orderId);

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending"); // not paid despite 'succeeded'
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("amount_mismatch");
    expect(await inIndex(orderId)).toBe(false);
  });
});

describe("[regression] expired order without an attached payment id", () => {
  async function seedUnattachedExpiredOrder(): Promise<string> {
    const order = makeOrder({ holdExpiresAt: Date.now() - 60_000 });
    expect(await reserveAndCreateOrder(order, 10)).toBe("created");
    return order.id;
  }

  it("retains and flags when a provider payment was attempted (possible orphan)", async () => {
    const orderId = await seedUnattachedExpiredOrder();
    await markPaymentAttempt(orderId);
    const afterReserve = await counter();

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("no_payment_id_but_attempt_made");
    expect(await inIndex(orderId)).toBe(false);
  });

  it("releases only when durable evidence shows no provider call was ever made", async () => {
    const orderId = await seedUnattachedExpiredOrder(); // no attempt marker
    const afterReserve = await counter();

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("expired");
    expect(await counter()).toBe(afterReserve + 1);
  });

  it("the order route clears the attempt marker once the payment id is attached", async () => {
    const { orderId } = await createOrder();
    expect(await r.exists(`payment_attempt:${orderId}`)).toBe(0);
  });
});

describe("[regression] webhook success racing expiry", () => {
  it("expiry that finds the payment already succeeded marks paid and releases nothing", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(0);
    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(afterReserve);
  });

  it("a webhook success that lands first leaves expiry a no-op with consistent inventory", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    await expireHold(orderId);

    const raw = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event_type: "payment_succeeded",
      content: { object: { payment_id: paymentId } },
    });
    const res = await webhook(
      makeWebhookRequest(raw, signWebhookBody(raw, TEST_HYPERSWITCH_WEBHOOK_SECRET))
    );
    expect(res.status).toBe(200);

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(afterReserve);
    expect(cancelCalls()).toBe(0);
    expect(await inIndex(orderId)).toBe(false);
  });
});

describe("[regression] lazy expiry work is bounded", () => {
  it(`processes at most ${HOLD_EXPIRY_BATCH_SIZE} expired holds per pass with a backlog`, async () => {
    const gaKey = `inventory:${EVENT_ID}:GA`;
    await r.set(gaKey, 10);
    const backlog = HOLD_EXPIRY_BATCH_SIZE + 2;
    const base = Date.now() - 60_000;
    for (let i = 0; i < backlog; i++) {
      const order = makeOrder({ tierName: "GA", holdExpiresAt: base + i });
      await r.set(`order:${order.id}`, order);
      await r.zadd("pending_holds", { score: base + i, member: order.id });
    }

    await runExpiryPass();
    expect(await r.zcard("pending_holds")).toBe(backlog - HOLD_EXPIRY_BATCH_SIZE);
    expect(await counter(gaKey)).toBe(10 + HOLD_EXPIRY_BATCH_SIZE);

    await runExpiryPass();
    expect(await r.zcard("pending_holds")).toBe(0);
    expect(await counter(gaKey)).toBe(10 + backlog);
  });

  it("each held order costs at most three provider calls in a pass (read, cancel, re-read)", async () => {
    const { orderId } = await createOrder();
    getFake().getFailsAfterCancel = true; // forces the longest path
    await expireHold(orderId);
    const before = getFake().calls.length;

    await runExpiryPass();

    expect(getFake().calls.length - before).toBe(3);
  });
});
