import { describe, expect, it } from "vitest";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as paymentStatus } from "@/app/api/payments/[id]/route";
import { getReconciliationFlag, updateOrderStatus } from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.3: the payment-status read reconciles with the SAME
// binding and outcome policy as the webhook and lazy expiry. Previously it
// trusted metadata.orderId alone and released inventory on 'failed'. Now a
// retryable failed payment is retained (so status polling cannot free a seat
// expiry is holding), metadata alone authorizes nothing, and a success that
// conflicts with an already-resolved order is recorded, not overwritten.
//
// (This route still does not authorize the CALLER — that is the deferred
// guest-authorization phase; these tests do not claim otherwise.)

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const r = makeTestRedis();

async function createOrder(): Promise<{ orderId: string; paymentId: string }> {
  const res = await createOrderRoute(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: EVENT_ID, tierName: TIER, quantity: 1 }),
    })
  );
  const data = await res.json();
  return { orderId: data.orderId, paymentId: data.paymentId };
}

function lookup(id: string) {
  return paymentStatus(new Request(`http://localhost/api/payments/${id}`), {
    params: Promise.resolve({ id }),
  });
}

async function statusOf(orderId: string): Promise<string> {
  return (await r.get<Order>(`order:${orderId}`))!.status;
}

async function counter(): Promise<number> {
  return Number(await r.get<number>(INV_KEY));
}

describe("[regression] payment-status read uses the shared reconciliation policy", () => {
  it("retains (does not release) a retryable failed payment and flags it", async () => {
    const { orderId, paymentId } = await createOrder();
    const before = await counter();
    getFake().getPayment(paymentId)!.status = "failed";

    const res = await lookup(paymentId);

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("failed"); // still reports the truth
    expect(await statusOf(orderId)).toBe("pending"); // not released
    expect(await counter()).toBe(before);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("payment_failed_retryable");
  });

  it("marks a verified, bound success paid without releasing", async () => {
    const { orderId, paymentId } = await createOrder();
    const before = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";

    await lookup(paymentId);

    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(before);
  });

  it("releases a confirmed cancellation exactly as the webhook would", async () => {
    const { orderId, paymentId } = await createOrder();
    const before = await counter();
    getFake().getPayment(paymentId)!.status = "cancelled";

    await lookup(paymentId);
    await lookup(paymentId); // repeated polling: still a single release

    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(before + 1);
  });

  it("does not let metadata alone bind a payment to an order (association mismatch)", async () => {
    const { orderId } = await createOrder();
    const before = await counter();
    // A different payment whose metadata names our order; our order's stored
    // paymentId points elsewhere.
    getFake().seedPayment({
      payment_id: "pay_rogue",
      status: "succeeded",
      amount: 11000,
      currency: "USD",
      metadata: { orderId },
    });

    const res = await lookup("pay_rogue");

    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(before);
  });

  it("applies the amount binding check: a mismatched success changes nothing", async () => {
    const { orderId, paymentId } = await createOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.amount = 1;

    await lookup(paymentId);

    expect(await statusOf(orderId)).toBe("pending");
  });

  it("records, rather than overwrites, a success conflicting with a resolved order", async () => {
    const { orderId, paymentId } = await createOrder();
    await updateOrderStatus(orderId, "expired"); // already released locally
    const afterRelease = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded"; // stale/late evidence

    await lookup(paymentId);

    expect(await statusOf(orderId)).toBe("expired"); // no silent overwrite / ticket
    expect(await counter()).toBe(afterRelease); // no inventory change
    expect((await getReconciliationFlag(orderId))?.reason).toBe(
      "conflict_succeeded_over_expired"
    );
  });

  it("returns 404 without the raw provider body for an unknown payment", async () => {
    const res = await lookup("pay_does_not_exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Payment unavailable" });
  });
});
