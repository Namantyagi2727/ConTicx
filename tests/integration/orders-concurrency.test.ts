import { describe, expect, it } from "vitest";
import { POST as createOrder } from "@/app/api/orders/route";
import { getEvent } from "@/lib/events";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { makeTestRedis } from "../helpers/redis";
import { newGuest, orderRequest as guestOrderRequest } from "../helpers/guest";

// T1A-06 (scenario 1: concurrent orders exceeding capacity) and
// scenario 2 (successful orders have matching persisted records,
// payment IDs, and hold entries). Exercises the real route handler,
// the real store, local Redis, and the fake provider — asserting on
// RAW counters and stored records, never clamped UI values.

const EVENT_ID = "midnight-parade";
const TIER = "VIP"; // 10 total — see lib/events.ts

// One guest places every order (Phase 1B.4: a booking needs an established
// guest session), which also exercises one identity owning many bookings.
function orderRequest(cookie: string, quantity: number): Request {
  return guestOrderRequest(cookie, { eventId: EVENT_ID, tierName: TIER, quantity });
}

describe("POST /api/orders under concurrency", () => {
  it("never oversells a tier and persists exactly the successful orders", async () => {
    const tier = getEvent(EVENT_ID)!.tiers.find((t) => t.name === TIER)!;
    const capacity = tier.totalInventory;
    const requestCount = capacity + 5; // 15 requests for 10 seats

    const guest = await newGuest();
    const responses = await Promise.all(
      Array.from({ length: requestCount }, () => createOrder(orderRequest(guest, 1)))
    );

    const statuses = responses.map((r) => r.status);
    const succeeded = statuses.filter((s) => s === 200).length;
    const rejected = statuses.filter((s) => s === 400).length;

    // Exactly `capacity` succeed; the rest are cleanly rejected.
    expect(succeeded).toBe(capacity);
    expect(rejected).toBe(requestCount - capacity);

    const r = makeTestRedis();

    // Raw counter sits exactly at zero — no oversell, no drift below 0.
    const remaining = await r.get<number>(`inventory:${EVENT_ID}:${TIER}`);
    expect(remaining).toBe(0);

    // One persisted order and one hold per success.
    const orderKeys = await r.keys("order:*");
    expect(orderKeys.length).toBe(capacity);
    expect(await r.zcard("pending_holds")).toBe(capacity);

    // The fake was asked to create exactly one payment per success
    // (reservations that lost the race never reach the provider).
    const createCalls = getFake().calls.filter(
      (c) => c.method === "POST" && c.path === "/payments"
    );
    expect(createCalls.length).toBe(capacity);

    // Each successful response maps to a stored, pending order that has
    // a payment id and a matching hold entry.
    const bodies = await Promise.all(
      responses.filter((res) => res.status === 200).map((res) => res.json())
    );
    for (const body of bodies) {
      const order = await r.get<Order>(`order:${body.orderId}`);
      expect(order).not.toBeNull();
      expect(order!.status).toBe("pending");
      expect(order!.paymentId).toBeTruthy();
      // The provider payment id stays server-side; the browser gets the
      // order id (and the widget's client secret) only.
      expect(body.paymentId).toBeUndefined();
      expect(order!.ownerHash).toMatch(/^[0-9a-f]{64}$/);
      const holdScore = await r.zscore("pending_holds", body.orderId);
      expect(holdScore).not.toBeNull();
    }
  });
});
