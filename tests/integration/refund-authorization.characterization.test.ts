import { describe, expect, it } from "vitest";
import { POST as createOrder } from "@/app/api/orders/route";
import { POST as refund } from "@/app/api/orders/[id]/refund/route";
import type { Order } from "@/lib/types";
import { makeTestRedis } from "../helpers/redis";

// CHARACTERIZATION TEST — asserts the CURRENT, INCORRECT behavior.
// Audit finding: SEC-02 (order id acts as an unrestricted credential;
// the refund route has no ownership/authorization check).
//
// Anyone who knows an order id can refund it: the request carries no
// cookie, token, or any proof of ownership, yet the refund succeeds and
// the seat is released. This PASSES today because the defect is present;
// it is NOT an authorization guarantee. In Phase 1B it must become a
// regression test: a caller without the per-order credential gets a
// uniform 404 and nothing changes.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";

function orderRequest() {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: EVENT_ID, tierName: TIER, quantity: 1 }),
  });
}

function refundRequest(orderId: string) {
  // No credentials of any kind — just the order id in the path.
  const req = new Request(`http://localhost/api/orders/${orderId}/refund`, { method: "POST" });
  return refund(req, { params: Promise.resolve({ id: orderId }) });
}

describe("[characterization] SEC-02 refund requires no ownership", () => {
  it("refunds a succeeded order for an unauthenticated caller (DEFECT)", async () => {
    const created = await createOrder(orderRequest());
    const { orderId } = await created.json();

    const r = makeTestRedis();

    // Make the order refundable (a real payment success would do this;
    // here we set it directly to isolate the authorization defect).
    const order = (await r.get<Order>(`order:${orderId}`))!;
    order.status = "succeeded";
    await r.set(`order:${orderId}`, order);
    const remainingBefore = (await r.get<number>(`inventory:${EVENT_ID}:${TIER}`))!;

    const res = await refundRequest(orderId);
    const data = await res.json();

    // Current behavior: the refund goes through with no ownership proof.
    expect(res.status).toBe(200);
    expect(data.refunded).toBe(true);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("refunded");
    expect((await r.get<number>(`inventory:${EVENT_ID}:${TIER}`))!).toBe(remainingBefore + 1);
  });
});
