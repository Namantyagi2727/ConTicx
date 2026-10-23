import { describe, expect, it } from "vitest";
import { POST as createOrder } from "@/app/api/orders/route";
import { POST as webhook } from "@/app/api/webhooks/hyperswitch/route";
import type { Order } from "@/lib/types";
import { makeTestRedis } from "../helpers/redis";
import { makeWebhookRequest } from "../helpers/webhook";

// REGRESSION — converted from the SEC-01 characterization test.
//
// Audit finding SEC-01: an unsigned/unverified webhook could drive a
// pending order to "succeeded". The old characterization test asserted
// that DEFECT (an unsigned forged webhook was accepted with 200 and
// applied). Phase 1B.2 closes it: the handler verifies an HMAC-SHA512
// signature fail-closed, so a forged delivery with no valid signature is
// rejected (401) and the order is left exactly as it was. The broader
// signature/binding/dedup matrix lives in webhook-security.regression.
//
// (The full forged-but-signed cases are impossible without the secret, so
// this file focuses on the core SEC-01 guarantee: no signature, no effect.)

function orderRequest() {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "midnight-parade", tierName: "VIP", quantity: 1 }),
  });
}

function forgedBody(orderId: string): string {
  // Attacker-chosen payment id and order id, no signing secret available.
  return JSON.stringify({
    event_id: "evt_forged",
    event_type: "payment_succeeded",
    content: { object: { payment_id: "forged_by_anyone", metadata: { orderId } } },
  });
}

describe("[regression] SEC-01 unsigned webhook cannot forge payment success", () => {
  it("rejects an unsigned forged webhook with 401 and leaves the order unchanged", async () => {
    const created = await createOrder(orderRequest());
    expect(created.status).toBe(200);
    const { orderId } = await created.json();

    const r = makeTestRedis();
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("pending");

    // No X-Webhook-Signature-512 header at all.
    const res = await webhook(makeWebhookRequest(forgedBody(orderId)));

    expect(res.status).toBe(401);
    // The order must be untouched.
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("pending");
  });

  it("rejects a forged webhook carrying a bogus signature and leaves the order unchanged", async () => {
    const created = await createOrder(orderRequest());
    const { orderId } = await created.json();
    const r = makeTestRedis();

    // A plausible-looking but wrong 128-hex signature (attacker cannot
    // produce a valid one without payment_response_hash_key).
    const res = await webhook(makeWebhookRequest(forgedBody(orderId), "a".repeat(128)));

    expect(res.status).toBe(401);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("pending");
  });
});
