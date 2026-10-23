import { describe, expect, it } from "vitest";
import {
  getRemainingInventory,
  InventoryStateError,
  reserveAndCreateOrder,
  transitionOrder,
} from "@/lib/store";
import { MAX_INVENTORY } from "@/lib/constants";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis, rawEquals, setRawString } from "../helpers/redis";

// REGRESSION — Phase 1B.1 verification: Redis integer-representation and
// arithmetic validation. tonumber() accepting a value is NOT enough —
// DECRBY/INCRBY need a canonical integer string. Counters are written as
// RAW bytes (setRawString) so the SDK cannot normalize the fixture, and
// unchanged-key assertions compare raw bytes (rawEquals) for the same
// reason. Every rejected operation must leave all affected keys untouched.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const CAPACITY = 10;

// Values tonumber() parses but Redis integer ops reject.
const NON_CANONICAL = ["1.5", "1.0", "1e2"];

describe("inventory counter representation", () => {
  for (const bad of NON_CANONICAL) {
    it(`reserve rejects a counter of ${JSON.stringify(bad)} with no write`, async () => {
      const r = makeTestRedis();
      await setRawString(r, INV_KEY, bad);
      const order = makeOrder({ quantity: 1 });

      expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("error");

      expect(await rawEquals(r, INV_KEY, bad)).toBe(true); // counter untouched
      expect(await r.get(`order:${order.id}`)).toBeNull();
      expect(await r.zcard("pending_holds")).toBe(0);
    });

    it(`availability read rejects a counter of ${JSON.stringify(bad)}`, async () => {
      const r = makeTestRedis();
      await setRawString(r, INV_KEY, bad);

      await expect(getRemainingInventory(EVENT_ID, TIER, CAPACITY)).rejects.toBeInstanceOf(
        InventoryStateError
      );
      expect(await rawEquals(r, INV_KEY, bad)).toBe(true); // not normalized
    });

    it(`release rejects a counter of ${JSON.stringify(bad)} with no write`, async () => {
      const r = makeTestRedis();
      const order = makeOrder({ status: "succeeded", quantity: 1 });
      await r.set(`order:${order.id}`, order);
      await setRawString(r, INV_KEY, bad);

      expect(await transitionOrder(order.id, "succeeded", "refunded", true)).toBe("error");

      expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded");
      expect(await rawEquals(r, INV_KEY, bad)).toBe(true);
    });
  }

  it("reserve rejects an out-of-range counter with no write", async () => {
    const r = makeTestRedis();
    await setRawString(r, INV_KEY, "2000000000"); // > MAX_INVENTORY
    const order = makeOrder({ quantity: 1 });

    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("error");

    expect(await rawEquals(r, INV_KEY, "2000000000")).toBe(true);
    expect(await r.get(`order:${order.id}`)).toBeNull();
  });

  it("release rejects an increment that would exceed the safe bound (overflow) with no write", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ status: "succeeded", quantity: 1 });
    await r.set(`order:${order.id}`, order);
    await setRawString(r, INV_KEY, String(MAX_INVENTORY)); // +1 would overflow the bound

    expect(await transitionOrder(order.id, "succeeded", "refunded", true)).toBe("error");

    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded");
    expect(await rawEquals(r, INV_KEY, String(MAX_INVENTORY))).toBe(true);
  });
});

describe("quantity representation", () => {
  it("reserve rejects a fractional quantity with no write", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1.5 });

    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("error");

    expect(await r.exists(INV_KEY)).toBe(0);
    expect(await r.get(`order:${order.id}`)).toBeNull();
    expect(await r.zcard("pending_holds")).toBe(0);
  });

  it("release rejects a zero stored quantity with no write", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ status: "succeeded", quantity: 0 });
    await r.set(`order:${order.id}`, order);
    await r.set(INV_KEY, CAPACITY - 1);

    expect(await transitionOrder(order.id, "succeeded", "refunded", true)).toBe("error");

    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded");
    expect(await r.get<number>(INV_KEY)).toBe(CAPACITY - 1);
  });

  it("release rejects a fractional stored quantity with no write", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ status: "succeeded", quantity: 1.5 });
    await r.set(`order:${order.id}`, order);
    await r.set(INV_KEY, CAPACITY - 1);

    expect(await transitionOrder(order.id, "succeeded", "refunded", true)).toBe("error");

    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("succeeded");
    expect(await r.get<number>(INV_KEY)).toBe(CAPACITY - 1);
  });
});
