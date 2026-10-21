import { describe, expect, it } from "vitest";
import { POST as createOrder } from "@/app/api/orders/route";
import { getOrder } from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { makeTestRedis } from "../helpers/redis";

// CHARACTERIZATION TEST — asserts the CURRENT, INCORRECT behavior.
// Audit finding: INV-01 (hold expiry treats any HTTP 400 from cancel as
// payment success).
//
// This test PASSES today because the defect is present: when a hold
// expires and the provider rejects the cancel with 400, the order is
// marked "succeeded" and its seat is kept — even though a 400 can mean
// the payment failed or was cancelled, not only that it succeeded. It
// is NOT a correctness guarantee. In Phase 1B it must become a
// regression test: after a non-2xx cancel, the code re-fetches the
// payment and maps the REAL status, releasing the seat on a genuine
// failure.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";

function orderRequest() {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: EVENT_ID, tierName: TIER, quantity: 1 }),
  });
}

describe("[characterization] INV-01 expiry reads cancel-400 as success", () => {
  it("marks an expired, unpaid hold as succeeded and keeps the seat (DEFECT)", async () => {
    const created = await createOrder(orderRequest());
    const { orderId } = await created.json();

    const r = makeTestRedis();
    const remainingAfterReserve = await r.get<number>(`inventory:${EVENT_ID}:${TIER}`);

    // Force the hold to look expired: move the order's hold into the
    // past and re-score its pending-holds entry so the reaper selects it.
    const order = (await r.get<Order>(`order:${orderId}`))!;
    const pastMs = Date.now() - 60_000;
    order.holdExpiresAt = pastMs;
    await r.set(`order:${orderId}`, order);
    await r.zadd("pending_holds", { score: pastMs, member: orderId });

    // The provider rejects the cancel with 400 (intent moved past a
    // cancellable state, per the audit's reading of payment_cancel.rs).
    getFake().cancelRejectsWith400 = true;

    // Any store read runs the lazy reaper.
    await getOrder(orderId);

    const after = (await r.get<Order>(`order:${orderId}`))!;
    // Current behavior: inferred success from the 400.
    expect(after.status).toBe("succeeded");

    // Seat was NOT released (still reserved at the post-reserve level).
    const remainingNow = await r.get<number>(`inventory:${EVENT_ID}:${TIER}`);
    expect(remainingNow).toBe(remainingAfterReserve);

    // Confirm the defect actually ran through the cancel path.
    const cancelCalls = getFake().calls.filter((c) => c.path.endsWith("/cancel"));
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
  });
});
