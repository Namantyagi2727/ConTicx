import { describe, expect, it } from "vitest";
import { reserveAndCreateOrder, transitionOrder } from "@/lib/store";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1 verification, concern 3: pre-write validation.
// A Lua script does NOT roll back writes that ran before a later error,
// so every key a script writes (inventory counter, order, hold index) is
// type/content-checked up front. These tests corrupt a key that would
// only be touched late in the mutation sequence and assert the operation
// is rejected with NO partial write.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const CAPACITY = 10;

describe("pre-write validation prevents partial writes", () => {
  it("reserve rejects a non-integer inventory counter without any write", async () => {
    const r = makeTestRedis();
    await r.set(INV_KEY, "not-a-number"); // corrupt counter content (type string, non-numeric)
    const order = makeOrder({ quantity: 1 });

    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("error");

    expect(await r.get(INV_KEY)).toBe("not-a-number"); // untouched
    expect(await r.get(`order:${order.id}`)).toBeNull(); // no order written
    expect(await r.zcard("pending_holds")).toBe(0); // no hold written
  });

  it("a releasing transition rejects a corrupt hold index before any write", async () => {
    const r = makeTestRedis();
    // Without the pre-write hold-type check, ZREM would error AFTER the
    // status SET, leaving the order written but the release half-done.
    const order = makeOrder({ status: "succeeded" });
    await r.set(`order:${order.id}`, order);
    await r.set(INV_KEY, CAPACITY - 1);
    await r.set("pending_holds", "corrupt"); // wrong type for a ZSET

    expect(await transitionOrder(order.id, "succeeded", "refunded", true)).toBe("error");

    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded"); // not written
    expect(await r.get<number>(INV_KEY)).toBe(CAPACITY - 1); // not incremented
    expect(await r.get("pending_holds")).toBe("corrupt"); // untouched
  });

  it("a releasing transition rejects a non-integer counter before any write", async () => {
    const r = makeTestRedis();
    // Without the pre-write content check, INCRBY would error AFTER the
    // status SET and the ZREM.
    const order = makeOrder({ status: "succeeded" });
    await r.set(`order:${order.id}`, order);
    await r.set(INV_KEY, "not-a-number");

    expect(await transitionOrder(order.id, "succeeded", "refunded", true)).toBe("error");

    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded"); // not written
    expect(await r.get(INV_KEY)).toBe("not-a-number"); // not incremented
  });
});
