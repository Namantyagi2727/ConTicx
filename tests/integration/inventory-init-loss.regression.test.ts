import { describe, expect, it } from "vitest";
import {
  getRemainingInventory,
  InventoryStateError,
  reserveAndCreateOrder,
  transitionOrder,
} from "@/lib/store";
import type { Order } from "@/lib/types";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — Phase 1B.1 verification, concern 2: first initialization
// vs a lost inventory counter. An absent counter alone cannot tell a
// genuinely new tier from one whose counter was lost, so a persistent
// per-tier init record (inventory_init:<event>:<tier>) is the evidence
// that distinguishes them. A new tier seeds both; a lost counter (init
// record present, counter gone) is refused by every path — no reset to
// full, no counter fabricated from incomplete accounting.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const INIT_KEY = `inventory_init:${EVENT_ID}:${TIER}`;
const CAPACITY = 10;

describe("inventory initialization vs lost counter", () => {
  it("a genuinely new tier seeds the counter and a persistent init record", async () => {
    const r = makeTestRedis();
    expect(await r.exists(INV_KEY)).toBe(0);
    expect(await r.exists(INIT_KEY)).toBe(0);

    expect(await getRemainingInventory(EVENT_ID, TIER, CAPACITY)).toBe(CAPACITY);

    expect(await r.get<number>(INV_KEY)).toBe(CAPACITY);
    expect(await r.exists(INIT_KEY)).toBe(1); // evidence the tier was initialized
  });

  it("refuses to reset availability when only the counter is lost", async () => {
    const r = makeTestRedis();
    const order = makeOrder({ quantity: 1 });
    expect(await reserveAndCreateOrder(order, CAPACITY)).toBe("created");
    expect(await r.exists(INIT_KEY)).toBe(1);
    expect(await r.get<number>(INV_KEY)).toBe(CAPACITY - 1);

    // Delete ONLY the counter; init record + order + hold remain.
    await r.del(INV_KEY);
    expect(await r.exists(INV_KEY)).toBe(0);
    expect(await r.exists(INIT_KEY)).toBe(1);

    // 1. Availability read must not silently reseed to full.
    await expect(getRemainingInventory(EVENT_ID, TIER, CAPACITY)).rejects.toBeInstanceOf(
      InventoryStateError
    );
    expect(await r.exists(INV_KEY)).toBe(0); // not recreated

    // 2. A new reservation must refuse without recreating the counter.
    const another = makeOrder({ quantity: 1 });
    expect(await reserveAndCreateOrder(another, CAPACITY)).toBe("lost");
    expect(await r.exists(INV_KEY)).toBe(0);
    expect(await r.get(`order:${another.id}`)).toBeNull();

    // 3. A release transition for the existing order must refuse, not
    //    fabricate a counter from incomplete accounting.
    expect(await transitionOrder(order.id, "pending", "failed", true)).toBe("error");
    expect(await r.exists(INV_KEY)).toBe(0);
    expect((await r.get<Order>(`order:${order.id}`))!.status).toBe("pending"); // unchanged
  });
});
