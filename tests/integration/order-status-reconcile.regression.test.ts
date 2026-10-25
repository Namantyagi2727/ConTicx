import { describe, expect, it } from "vitest";
import { GET as orderStatus } from "@/app/api/orders/[id]/status/route";
import { getReconciliationFlag, updateOrderStatus } from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { makeTestRedis } from "../helpers/redis";
import { createOwnedOrder, guestRequest } from "../helpers/guest";

// REGRESSION — the guest-facing status refresh reconciles with the SAME
// binding and outcome policy as the webhook and lazy expiry (Phase 1B.3),
// now through the order-scoped GET /api/orders/[id]/status (Phase 1B.4)
// instead of the retired public GET /api/payments/[id]. The provider payment
// id comes from the OWNED stored order, never from the client, so a retryable
// failed payment is retained and a payment whose metadata merely names the
// order cannot bind to it. As with the old route, an already-terminal owned
// order is still reconciled: its state and inventory stay put and a
// conflicting authoritative outcome is recorded. Authorization of the caller
// (an unauthorized poll makes no provider call and changes nothing) is
// covered in guest-authorization.regression.test.ts.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const r = makeTestRedis();

function poll(orderId: string, cookie: string) {
  return orderStatus(guestRequest(`/api/orders/${orderId}/status`, { cookie }), {
    params: Promise.resolve({ id: orderId }),
  });
}

async function statusOf(orderId: string): Promise<string> {
  return (await r.get<Order>(`order:${orderId}`))!.status;
}

async function counter(): Promise<number> {
  return Number(await r.get<number>(INV_KEY));
}

function paymentReads(): string[] {
  return getFake()
    .calls.filter((c) => c.method === "GET" && c.path.startsWith("/payments/"))
    .map((c) => c.path);
}

describe("[regression] order status refresh uses the shared reconciliation policy", () => {
  it("retains (does not release) a retryable failed payment and flags it", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    const before = await counter();
    getFake().getPayment(paymentId)!.status = "failed";

    const res = await poll(orderId, cookie);

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending"); // the order, not the payment
    expect(await statusOf(orderId)).toBe("pending"); // not released
    expect(await counter()).toBe(before);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("payment_failed_retryable");
  });

  it("marks a verified, bound success paid without releasing", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    const before = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";

    const res = await poll(orderId, cookie);

    expect((await res.json()).status).toBe("succeeded");
    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(before);
  });

  it("releases a confirmed cancellation exactly once under repeated polling", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    const before = await counter();
    getFake().getPayment(paymentId)!.status = "cancelled";

    await poll(orderId, cookie);
    await poll(orderId, cookie);

    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(before + 1);
  });

  it("reads only the order's own payment: a rogue payment naming the order binds nothing", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    const before = await counter();
    getFake().seedPayment({
      payment_id: "pay_rogue",
      status: "succeeded",
      amount: 11000,
      currency: "USD",
      metadata: { orderId },
    });
    const reads0 = paymentReads().length;

    const res = await poll(orderId, cookie);

    expect(res.status).toBe(200);
    expect(paymentReads().slice(reads0)).toEqual([`/payments/${paymentId}`]);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(before);
  });

  it("applies the amount binding check: a mismatched success changes nothing", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.amount = 1;

    await poll(orderId, cookie);

    expect(await statusOf(orderId)).toBe("pending");
  });

  it("records, rather than overwrites, a success conflicting with an owned terminal order", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    await updateOrderStatus(orderId, "expired"); // already released locally
    const afterRelease = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded"; // late, authoritative
    const reads0 = paymentReads();

    const res = await poll(orderId, cookie);

    // The provider WAS consulted, with the order's own payment id ...
    expect(paymentReads().slice(reads0.length)).toEqual([`/payments/${paymentId}`]);
    // ... but the terminal state and inventory are untouched (no ticket) ...
    expect((await res.json()).status).toBe("expired");
    expect(await statusOf(orderId)).toBe("expired");
    expect(await counter()).toBe(afterRelease);
    // ... and the conflict is recorded through the shared policy.
    expect((await getReconciliationFlag(orderId))?.reason).toBe(
      "conflict_succeeded_over_expired"
    );
    expect(await r.zscore("reconcile_needed", orderId)).not.toBeNull();
  });

  it("re-polling a settled owned order keeps it settled without a second effect", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    await poll(orderId, cookie);
    const afterPaid = await counter();

    await poll(orderId, cookie);

    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(afterPaid);
    expect(await getReconciliationFlag(orderId)).toBeNull();
  });

  it("never puts a malformed stored payment id into a provider path", async () => {
    const { orderId, cookie } = await createOwnedOrder();
    const stored = (await r.get<Order>(`order:${orderId}`))!;
    stored.paymentId = "../refunds?x=1";
    await r.set(`order:${orderId}`, stored);
    const calls = getFake().calls.length;

    const res = await poll(orderId, cookie);

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
    expect(getFake().calls.length).toBe(calls);
  });

  it("returns the stored view, without provider detail, when the provider fails", async () => {
    const { orderId, cookie } = await createOwnedOrder();
    getFake().getReturns500 = true;

    const res = await poll(orderId, cookie);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("pending");
    expect(Object.keys(body).sort()).toEqual(
      [
        "amountCents",
        "createdAt",
        "currency",
        "eventId",
        "feeCents",
        "holdExpiresAt",
        "id",
        "quantity",
        "status",
        "tierName",
        "unitPriceCents",
      ].sort()
    );
  });
});
