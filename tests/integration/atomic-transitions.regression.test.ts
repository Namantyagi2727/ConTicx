import { describe, expect, it } from "vitest";
import { reserveAndCreateOrder, transitionOrder, updateOrderStatus } from "@/lib/store";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1 atomic transitions + release (requirement B).
// Order status changes are a single guarded compare-and-set script that
// updates status, drops the hold, and applies the inventory effect
// together. Competing transitions cannot each apply a conflicting
// inventory effect; a repeated transition applies its effect once; and
// invalid state or wrong key types are rejected before any write.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const CAPACITY = 10;

async function seedPendingOrder(): Promise<string> {
  const order = makeOrder({ quantity: 1 });
  expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
  return order.id;
}

describe("atomic order transitions", () => {
  it("lets only one of two conflicting pending transitions apply, with a consistent inventory effect", async () => {
    const orderId = await seedPendingOrder();
    const r = makeTestRedis();
    const before = (await r.get<number>(INV_KEY))!; // 9 after one reserve

    // One path says the payment succeeded (keep the seat); the other says
    // it failed (release the seat). Exactly one must win.
    const [succeededResult, failedResult] = await Promise.all([
      transitionOrder(orderId, "pending", "succeeded", false),
      transitionOrder(orderId, "pending", "failed", true),
    ]);

    const applied = [succeededResult, failedResult].filter((x) => x === "applied");
    const conflicted = [succeededResult, failedResult].filter((x) => x === "conflict");
    expect(applied.length).toBe(1);
    expect(conflicted.length).toBe(1);

    const finalStatus = (await r.get<Order>(`order:${orderId}`))!.status;
    const after = (await r.get<number>(INV_KEY))!;

    // Accounting invariant holds regardless of which transition won:
    // succeeded keeps the seat, failed releases exactly one.
    if (finalStatus === "succeeded") {
      expect(after).toBe(before);
    } else {
      expect(finalStatus).toBe("failed");
      expect(after).toBe(before + 1);
    }
    // Either terminal transition removes the pending hold.
    expect(await r.zscore("pending_holds", orderId)).toBeNull();
  });

  it("applies a repeated pending->failed transition's release exactly once", async () => {
    const orderId = await seedPendingOrder();
    const r = makeTestRedis();
    const before = (await r.get<number>(INV_KEY))!;

    await updateOrderStatus(orderId, "failed");
    const afterFirst = (await r.get<number>(INV_KEY))!;
    await updateOrderStatus(orderId, "failed"); // redelivery / retry
    const afterSecond = (await r.get<number>(INV_KEY))!;

    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(before + 1);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("failed");
  });

  it("rejects an incompatible transition (wrong starting state) without any write", async () => {
    const orderId = await seedPendingOrder(); // still pending
    const r = makeTestRedis();
    const before = (await r.get<number>(INV_KEY))!;

    // succeeded -> refunded requires a succeeded order; this one is pending.
    const result = await transitionOrder(orderId, "succeeded", "refunded", true);
    expect(result).toBe("conflict");

    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("pending");
    expect(await r.get<number>(INV_KEY)).toBe(before);
    expect(await r.zscore("pending_holds", orderId)).not.toBeNull();
  });

  it("rejects a releasing transition against a wrong-typed inventory key without any write", async () => {
    const r = makeTestRedis();
    // A succeeded order whose inventory key is (wrongly) a list.
    const order = makeOrder({ status: "succeeded" });
    await r.set(`order:${order.id}`, order);
    await r.rpush(INV_KEY, "x");

    const result = await transitionOrder(order.id, "succeeded", "refunded", true);
    expect(result).toBe("error");

    // No partial write: status unchanged, the wrong-typed key intact.
    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded");
    expect(await r.lrange(INV_KEY, 0, -1)).toEqual(["x"]);
  });
});
