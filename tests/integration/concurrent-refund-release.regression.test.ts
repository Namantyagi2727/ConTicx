import { describe, expect, it } from "vitest";
import { markOrderRefunded, reserveAndCreateOrder } from "@/lib/store";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1, converted from the INV-02 double-release
// CHARACTERIZATION test. Audit finding INV-02: separate read/check/write
// transitions let two concurrent refunds both release one seat.
//
// markOrderRefunded is now a single atomic compare-and-set transition
// (succeeded -> refunded) that releases inventory in the same script. So
// two concurrent refunds on the same order apply the release EXACTLY
// once: one call performs the transition, the other sees "refunded" and
// no-ops. Retrying after a lost response is the same no-op.
//
// NOTE: this is a LOCAL-inventory guarantee. Two concurrent refund
// *requests* can still each call the provider (provider-side refund
// idempotency is deferred to a later subphase); this test is only about
// not releasing the seat twice locally.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const CAPACITY = 10;

async function seedSucceededOrder(): Promise<string> {
  const order = makeOrder({ quantity: 1 });
  const res = await reserveAndCreateOrder(order, CAPACITY);
  expect(res).toBe("created");
  // Advance to a refundable state directly (a real payment success would
  // do this via a transition; here we isolate the refund behavior).
  const r = makeTestRedis();
  const stored = (await r.get<Order>(`order:${order.id}`))!;
  stored.status = "succeeded";
  await r.set(`order:${order.id}`, stored);
  return order.id;
}

describe("concurrent refunds release a seat exactly once", () => {
  it("applies one release under a concurrent double refund (INV-02 fixed)", async () => {
    const orderId = await seedSucceededOrder();
    const r = makeTestRedis();
    const before = (await r.get<number>(INV_KEY))!; // 9 after one reserve

    const [a, b] = await Promise.all([markOrderRefunded(orderId), markOrderRefunded(orderId)]);

    // Exactly one call performed the refund; the other was a no-op.
    expect([a, b].filter(Boolean).length).toBe(1);

    const after = (await r.get<number>(INV_KEY))!;
    expect(after).toBe(before + 1); // released once, not twice
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("refunded");
    expect(await r.zscore("pending_holds", orderId)).toBeNull();
  });

  it("does not release again when the same refund is retried after a lost response", async () => {
    const orderId = await seedSucceededOrder();
    const r = makeTestRedis();
    const before = (await r.get<number>(INV_KEY))!;

    const first = await markOrderRefunded(orderId);
    const afterFirst = (await r.get<number>(INV_KEY))!;
    // The client never saw the response and retries the same operation.
    const retry = await markOrderRefunded(orderId);
    const afterRetry = (await r.get<number>(INV_KEY))!;

    expect(first).toBe(true);
    expect(retry).toBe(false);
    expect(afterFirst).toBe(before + 1);
    expect(afterRetry).toBe(before + 1); // retry added nothing
  });
});
