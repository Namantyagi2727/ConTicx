import { describe, expect, it } from "vitest";
import { reserveAndCreateOrder } from "@/lib/store";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1 atomic reserve-and-create (requirement A).
// Reserving inventory and persisting the order + hold index are now one
// atomic Redis script: they succeed together or not at all, and an
// insufficient request mutates nothing. Assertions read RAW Redis state,
// never the clamped display value.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;

describe("atomic reserve-and-create", () => {
  it("never exceeds capacity under concurrency; reserves, orders, holds, and raw inventory agree", async () => {
    const capacity = 3;
    const attempts = 8;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => reserveAndCreateOrder(makeOrder({ quantity: 1 }), capacity))
    );

    const created = results.filter((r) => r === "created").length;
    const soldOut = results.filter((r) => r === "sold_out").length;
    expect(created).toBe(capacity);
    expect(soldOut).toBe(attempts - capacity);

    const r = makeTestRedis();
    // Raw counter sits exactly at zero — no oversell, no drift below 0.
    expect(await r.get<number>(INV_KEY)).toBe(0);
    // Exactly one persisted order and one hold per successful reserve.
    expect((await r.keys("order:*")).length).toBe(capacity);
    expect(await r.zcard("pending_holds")).toBe(capacity);
    // seed(3) - remaining(0) == orders == holds == reserves.
    expect(capacity - (await r.get<number>(INV_KEY))!).toBe(created);
  });

  it("leaves no order, no hold, and the counter untouched when inventory is insufficient", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 5 });

    const result = await reserveAndCreateOrder(order, 3); // want 5, capacity 3
    expect(result).toBe("sold_out");

    // No partial writes at all: the counter was never even seeded.
    expect(await r.exists(INV_KEY)).toBe(0);
    expect(await r.get(`order:${order.id}`)).toBeNull();
    expect(await r.zcard("pending_holds")).toBe(0);
  });

  it("rejects an invalid quantity without any write (input validation)", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 0 });

    const result = await reserveAndCreateOrder(order, 10);
    expect(result).toBe("error");

    expect(await r.exists(INV_KEY)).toBe(0);
    expect(await r.get(`order:${order.id}`)).toBeNull();
    expect(await r.zcard("pending_holds")).toBe(0);
  });

  it("rejects a wrong-typed inventory key without any write (key-type validation)", async () => {
    const r = makeTestRedis();
    // Pre-seed the inventory key as a LIST, not an integer string.
    await r.rpush(INV_KEY, "x");
    const order = makeOrder({ quantity: 1 });

    const result = await reserveAndCreateOrder(order, 10);
    expect(result).toBe("error");

    // The wrong-typed key is untouched and nothing was persisted.
    expect(await r.lrange(INV_KEY, 0, -1)).toEqual(["x"]);
    expect(await r.get(`order:${order.id}`)).toBeNull();
    expect(await r.zcard("pending_holds")).toBe(0);
  });
});
