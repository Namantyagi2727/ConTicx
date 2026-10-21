import { describe, expect, it } from "vitest";
import { POST as createOrder } from "@/app/api/orders/route";
import { POST as webhook } from "@/app/api/webhooks/hyperswitch/route";
import type { Order } from "@/lib/types";
import { makeTestRedis } from "../helpers/redis";

// CHARACTERIZATION TEST — asserts the CURRENT, INCORRECT behavior.
// Audit finding: SEC-01 (unsigned webhooks change order state).
//
// This test PASSES today because the vulnerability is present: an
// unauthenticated, unsigned webhook body can drive a pending order to
// "succeeded". It is NOT a security guarantee. In Phase 1B it must be
// converted into a regression test asserting the CORRECTED behavior:
// an unsigned/invalid-signature webhook is rejected (401) and the order
// is left unchanged.

function orderRequest() {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "midnight-parade", tierName: "VIP", quantity: 1 }),
  });
}

function forgedWebhook(orderId: string) {
  // No signature header, attacker-chosen payment id and order id.
  return new Request("http://localhost/api/webhooks/hyperswitch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_type: "payment_succeeded",
      content: { object: { payment_id: "forged_by_anyone", metadata: { orderId } } },
    }),
  });
}

describe("[characterization] SEC-01 unsigned webhook forges payment success", () => {
  it("promotes a pending order to succeeded with no signature (DEFECT)", async () => {
    const created = await createOrder(orderRequest());
    expect(created.status).toBe(200);
    const { orderId } = await created.json();

    const r = makeTestRedis();
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("pending");

    const res = await webhook(forgedWebhook(orderId));

    // Current behavior: accepted and applied.
    expect(res.status).toBe(200);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("succeeded");
  });
});
