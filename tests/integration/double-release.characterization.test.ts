import { describe, expect, it } from "vitest";
import { POST as createOrder } from "@/app/api/orders/route";
import { markOrderRefunded } from "@/lib/store";
import type { Order } from "@/lib/types";
import { installReadWriteRace } from "../helpers/race";
import { makeTestRedis } from "../helpers/redis";

// CHARACTERIZATION TEST — asserts the CURRENT, INCORRECT behavior.
// Audit finding: INV-02 (read-check-write transitions are not atomic,
// so a seat can be released more than once).
//
// markOrderRefunded reads the order, checks status === "succeeded", then
// writes "refunded" and releases inventory — across separate Redis
// round-trips. Two concurrent refunds on the same succeeded order can
// both observe "succeeded" before either writes, so BOTH release the
// seat: inventory is incremented twice for one order. The interleaving
// is forced deterministically (the first write is held until both reads
// have happened), not with sleeps.
//
// This PASSES today because the defect is present. In Phase 1B it must
// become a regression test: one atomic compare-and-set transition, a
// single release, and the second concurrent refund is a no-op.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";

function orderRequest() {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: EVENT_ID, tierName: TIER, quantity: 1 }),
  });
}

describe("[characterization] INV-02 concurrent refunds double-release a seat", () => {
  it("releases inventory twice for one order under a forced race (DEFECT)", async () => {
    const created = await createOrder(orderRequest());
    const { orderId } = await created.json();

    const r = makeTestRedis();

    // Put the order into a refundable state deterministically.
    const order = (await r.get<Order>(`order:${orderId}`))!;
    order.status = "succeeded";
    await r.set(`order:${orderId}`, order);
    const remainingBefore = (await r.get<number>(`inventory:${EVENT_ID}:${TIER}`))!;

    // Hold the first write to order:<id> until BOTH concurrent calls
    // have read the (still "succeeded") record.
    const race = installReadWriteRace({
      readKey: `order:${orderId}`,
      writeCommand: "SET",
      writeKey: `order:${orderId}`,
      releaseAfterReads: 2,
    });

    try {
      const [a, b] = await Promise.all([markOrderRefunded(orderId), markOrderRefunded(orderId)]);
      // Both believed they performed the refund.
      expect(a).toBe(true);
      expect(b).toBe(true);
    } finally {
      race.dispose();
    }

    // Defect: the single seat was released twice.
    const remainingAfter = (await r.get<number>(`inventory:${EVENT_ID}:${TIER}`))!;
    expect(remainingAfter).toBe(remainingBefore + 2);
  });
});
