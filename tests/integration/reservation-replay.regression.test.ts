import { describe, expect, it } from "vitest";
import { reserveAndCreateOrder, transitionOrder } from "@/lib/store";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1 verification, concern 1: replay of the SAME
// internal reservation (same order id). The reserve script now guards
// against overwriting an existing order: a matching resubmission is an
// idempotent EXISTS, a different booking under the same id is a CONFLICT,
// and neither decrements inventory again or recreates a resolved hold.
// (This is internal-operation replay safety, NOT client checkout
// idempotency — a fresh HTTP checkout still mints a new order id.)

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const CAPACITY = 10;

describe("reservation replay and order-id collision", () => {
  it("sequential resubmission is EXISTS: one decrement, no overwrite, no second hold", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 });

    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
    const afterFirst = (await r.get<number>(INV_KEY))!; // 9
    const storedFirst = (await r.get<Order>(`order:${order.id}`))!;

    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("exists");

    expect(await r.get<number>(INV_KEY)).toBe(afterFirst); // no second decrement
    expect(await r.get<Order>(`order:${order.id}`)).toEqual(storedFirst); // unchanged
    expect(await r.zcard("pending_holds")).toBe(1); // one hold, not two
  });

  it("concurrent duplicate submissions decrement inventory exactly once", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 });

    const [a, b] = await Promise.all([
      reserveAndCreateOrder(order, CAPACITY),
      reserveAndCreateOrder(order, CAPACITY),
    ]);

    expect([a, b].sort()).toEqual(["created", "exists"]);
    expect(await r.get<number>(INV_KEY)).toBe(CAPACITY - 1); // one decrement
    expect(await r.zcard("pending_holds")).toBe(1);
  });

  it("a lost-response retry returns EXISTS without a second decrement", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 2 });

    const first = await reserveAndCreateOrder(order, CAPACITY); // caller never sees this
    const afterFirst = (await r.get<number>(INV_KEY))!; // 8
    const retry = await reserveAndCreateOrder(order, CAPACITY); // same op, retried

    expect(first).toBe("created");
    expect(retry).toBe("exists");
    expect(await r.get<number>(INV_KEY)).toBe(afterFirst);
  });

  it("same id with different booking details is CONFLICT without mutation", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 });
    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
    const afterFirst = (await r.get<number>(INV_KEY))!;
    const storedFirst = (await r.get<Order>(`order:${order.id}`))!;

    const conflicting = makeOrder({ id: order.id, quantity: 2, amountCents: 22000 });
    expect(await reserveAndCreateOrder(conflicting, CAPACITY)).toBe("conflict");

    expect(await r.get<number>(INV_KEY)).toBe(afterFirst); // no decrement
    expect(await r.get<Order>(`order:${order.id}`)).toEqual(storedFirst); // original intact
  });

  it("same total but different currency is CONFLICT without mutation", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 }); // USD, amountCents 11000
    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
    const afterFirst = (await r.get<number>(INV_KEY))!;
    const storedFirst = (await r.get<Order>(`order:${order.id}`))!;

    // Same total amount, different currency — must not match.
    const differentCurrency = makeOrder({ id: order.id, currency: "EUR" });
    expect(differentCurrency.amountCents).toBe(order.amountCents);
    expect(await reserveAndCreateOrder(differentCurrency, CAPACITY)).toBe("conflict");

    expect(await r.get<number>(INV_KEY)).toBe(afterFirst);
    expect(await r.get<Order>(`order:${order.id}`)).toEqual(storedFirst);
  });

  it("same total but different pricing breakdown is CONFLICT without mutation", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 }); // unit 10000 + fee 1000 = 11000
    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
    const afterFirst = (await r.get<number>(INV_KEY))!;
    const storedFirst = (await r.get<Order>(`order:${order.id}`))!;

    // Same total amount, different unit-price / fee split — must not match.
    const differentSplit = makeOrder({ id: order.id, unitPriceCents: 9000, feeCents: 2000 });
    expect(differentSplit.amountCents).toBe(order.amountCents);
    expect(await reserveAndCreateOrder(differentSplit, CAPACITY)).toBe("conflict");

    expect(await r.get<number>(INV_KEY)).toBe(afterFirst);
    expect(await r.get<Order>(`order:${order.id}`)).toEqual(storedFirst);
  });

  it("resubmission after the order advanced beyond pending is EXISTS and never resurrects it", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 });
    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");

    // Advance out of pending via a real transition (removes the hold).
    expect(await transitionOrder(order.id, "pending", "succeeded", false)).toBe("applied");
    const afterAdvance = (await r.get<number>(INV_KEY))!;
    expect(await r.zscore("pending_holds", order.id)).toBeNull();

    // A replayed creation must not reset status to pending or re-add the hold.
    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("exists");
    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded");
    expect(await r.zscore("pending_holds", order.id)).toBeNull(); // hold not recreated
    expect(await r.get<number>(INV_KEY)).toBe(afterAdvance); // no decrement
  });
});
