import { describe, expect, it } from "vitest";
import { attachPaymentId, reserveAndCreateOrder, updateOrderStatus } from "@/lib/store";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1 safe payment attachment (requirement C).
// Attaching the provider payment id sets ONLY that field on the current
// stored order. It never rewrites status or re-adds a hold (so it cannot
// resurrect a resolved order), is a no-op when the same id is re-attached,
// and refuses to overwrite a different id.

const CAPACITY = 10;

async function seedPendingOrder(): Promise<string> {
  const order = makeOrder({ quantity: 1 });
  expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
  return order.id;
}

describe("safe payment-id attachment", () => {
  it("does not resurrect pending state when attach races a succeeded transition", async () => {
    const orderId = await seedPendingOrder();
    const r = makeTestRedis();

    // Attach and a pending->succeeded transition hit the same order at once.
    await Promise.all([
      attachPaymentId(orderId, "pay_race"),
      updateOrderStatus(orderId, "succeeded"),
    ]);

    const order = (await r.get<Order>(`order:${orderId}`))!;
    // Regardless of interleaving: terminal status wins, id is attached,
    // and the hold is gone — the attach never reset status to pending.
    expect(order.status).toBe("succeeded");
    expect(order.paymentId).toBe("pay_race");
    expect(await r.zscore("pending_holds", orderId)).toBeNull();
  });

  it("attaching after a transition never rewinds the resolved status", async () => {
    const orderId = await seedPendingOrder();
    const r = makeTestRedis();

    await updateOrderStatus(orderId, "succeeded");
    const result = await attachPaymentId(orderId, "pay_after");

    expect(result).toBe("ok");
    const order = (await r.get<Order>(`order:${orderId}`))!;
    expect(order.status).toBe("succeeded"); // not reset to pending
    expect(order.paymentId).toBe("pay_after");
    expect(await r.zscore("pending_holds", orderId)).toBeNull();
  });

  it("treats a duplicate attach as a no-op and refuses a conflicting one", async () => {
    const orderId = await seedPendingOrder();
    const r = makeTestRedis();

    expect(await attachPaymentId(orderId, "pay_1")).toBe("ok");
    expect(await attachPaymentId(orderId, "pay_1")).toBe("noop"); // same id again
    expect(await attachPaymentId(orderId, "pay_2")).toBe("conflict"); // different id

    // The original association is intact after the refused overwrite.
    expect((await r.get<Order>(`order:${orderId}`))!.paymentId).toBe("pay_1");
  });

  it("rejects a malformed stored order without a write", async () => {
    const r = makeTestRedis();
    // A value that is not valid JSON (and not an object) at the order key.
    await r.set("order:broken", "not json{");

    const result = await attachPaymentId("broken", "pay_x");
    expect(result).toBe("error");

    // Left exactly as found — no partial write.
    expect(await r.get("order:broken")).toBe("not json{");
  });

  it("returns not_found for an order that does not exist", async () => {
    expect(await attachPaymentId("does-not-exist", "pay_x")).toBe("not_found");
  });
});
