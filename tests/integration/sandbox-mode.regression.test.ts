import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as createOrderRoute, GET as listOrdersRoute } from "@/app/api/orders/route";
import { GET as orderStatusRoute } from "@/app/api/orders/[id]/status/route";
import { POST as guestSessionRoute } from "@/app/api/guest-session/route";
import { POST as webhookRoute } from "@/app/api/webhooks/hyperswitch/route";
import EventPage from "@/app/events/[id]/page";
import { sandboxPaymentsConfigured } from "@/lib/app-mode";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import {
  TEST_HYPERSWITCH_API_KEY,
  TEST_HYPERSWITCH_BASE_URL,
  TEST_HYPERSWITCH_PUBLISHABLE_KEY,
  TEST_HYPERSWITCH_WEBHOOK_SECRET,
} from "../setup/constants";
import { makeTestRedis, snapshotRedis } from "../helpers/redis";
import { guestRequest, newGuest, orderRequest } from "../helpers/guest";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";

// REGRESSION — public sandbox: the Redis key namespace (CONTICX_REDIS_PREFIX)
// keeps the demo's data apart from anything else in a shared database, full
// mode refuses to run against anything but a Hyperswitch sandbox, and
// resuming checkout after a declined sandbox payment reports its outcome.

const r = makeTestRedis();

afterEach(() => {
  delete process.env.CONTICX_REDIS_PREFIX;
  process.env.HYPERSWITCH_BASE_URL = TEST_HYPERSWITCH_BASE_URL;
  process.env.HYPERSWITCH_API_KEY = TEST_HYPERSWITCH_API_KEY;
  process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY = TEST_HYPERSWITCH_PUBLISHABLE_KEY;
});

async function unprefixedSnapshot(prefix: string): Promise<string> {
  const keys = (await r.keys("*")).filter((k) => !k.startsWith(`${prefix}:`)).sort();
  const values = await Promise.all(keys.map((k) => r.get(k)));
  return JSON.stringify(keys.map((k, i) => [k, values[i]]));
}

describe("[regression] Redis key namespace", () => {
  beforeEach(async () => {
    // Pre-existing data from an earlier deployment sharing the database: a
    // nearly sold-out counter and an order under the bare key names.
    await r.set("inventory:midnight-parade:VIP", 1);
    await r.set("order:legacy-1", JSON.stringify({ id: "legacy-1", status: "pending" }));
  });

  it("keeps a whole booking inside the namespace and leaves other keys untouched", async () => {
    const before = await unprefixedSnapshot("sandbox1");
    process.env.CONTICX_REDIS_PREFIX = "sandbox1";

    const guest = await newGuest();
    const res = await createOrderRoute(
      orderRequest(guest, { eventId: "midnight-parade", tierName: "VIP", quantity: 2 })
    );
    expect(res.status).toBe(200); // the bare counter (1 left) is not the namespace's
    const { orderId } = await res.json();
    getFake().getPayment((await r.get<Order>(`sandbox1:order:${orderId}`))!.paymentId!)!.status = "succeeded";
    const status = await orderStatusRoute(guestRequest(`/api/orders/${orderId}/status`, { cookie: guest }), {
      params: Promise.resolve({ id: orderId }),
    });
    expect((await status.json()).status).toBe("succeeded");
    const listed = await (await listOrdersRoute(guestRequest("/api/orders", { cookie: guest }))).json();
    expect(listed.orders.map((o: { id: string }) => o.id)).toEqual([orderId]);

    expect(await unprefixedSnapshot("sandbox1")).toBe(before);
    expect(await r.get("sandbox1:inventory:midnight-parade:VIP")).toBe(8);
    const created = (await r.keys("sandbox1:*")).map((k) => k.split(":")[1]);
    expect(new Set(created)).toEqual(
      new Set(["guest_session", "order", "inventory", "inventory_init", "guest_orders", "booking_attempt", "demand"])
    );
  });

  it("does not see orders or sessions from outside the namespace", async () => {
    const guest = await newGuest(); // unprefixed session
    process.env.CONTICX_REDIS_PREFIX = "sandbox1";
    const res = await listOrdersRoute(guestRequest("/api/orders", { cookie: guest }));
    expect(res.status).toBe(401);
  });

  it("refuses to run with an invalid namespace, before any write", async () => {
    process.env.CONTICX_REDIS_PREFIX = "Bad Prefix!";
    const before = await snapshotRedis(r);
    const res = await guestSessionRoute(guestRequest("/api/guest-session", { method: "POST" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unavailable");
    expect(await snapshotRedis(r)).toBe(before);
  });
});

describe("[regression] sandbox-only payments", () => {
  it("accepts only the sandbox API host or a loopback fake, with sandbox keys", () => {
    const cases: [string, string, string, boolean][] = [
      ["https://sandbox.hyperswitch.io", "snd_x", "pk_snd_x", true],
      ["https://sandbox.hyperswitch.io/", "snd_x", "pk_snd_x", true],
      ["http://127.0.0.1:38171", "snd_x", "pk_snd_x", true],
      ["https://api.hyperswitch.io", "snd_x", "pk_snd_x", false],
      ["http://sandbox.hyperswitch.io", "snd_x", "pk_snd_x", false],
      ["https://sandbox.hyperswitch.io.evil.example", "snd_x", "pk_snd_x", false],
      ["https://sandbox.hyperswitch.io/v2", "snd_x", "pk_snd_x", false],
      ["https://sandbox.hyperswitch.io", "prd_x", "pk_snd_x", false],
      ["https://sandbox.hyperswitch.io", "snd_x", "pk_prd_x", false],
      ["", "snd_x", "pk_snd_x", false],
    ];
    for (const [base, key, pk, expected] of cases) {
      process.env.HYPERSWITCH_BASE_URL = base;
      process.env.HYPERSWITCH_API_KEY = key;
      process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY = pk;
      expect([base, key, pk, sandboxPaymentsConfigured()]).toEqual([base, key, pk, expected]);
    }
  });

  it("refuses every booking entry point with non-sandbox settings, before any work", async () => {
    const guest = await newGuest();
    process.env.HYPERSWITCH_BASE_URL = "https://api.hyperswitch.io";
    const before = await snapshotRedis(r);
    const calls = getFake().calls.length;
    const body = JSON.stringify({ event_id: `evt_${randomUUID()}`, event_type: "payment_succeeded", content: { object: { payment_id: "pay_x" } } });

    const responses = [
      await guestSessionRoute(guestRequest("/api/guest-session", { method: "POST" })),
      await createOrderRoute(orderRequest(guest)),
      await listOrdersRoute(guestRequest("/api/orders", { cookie: guest })),
      await webhookRoute(makeWebhookRequest(body, signWebhookBody(body, TEST_HYPERSWITCH_WEBHOOK_SECRET))),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("payments_unavailable");
    }
    await EventPage({ params: Promise.resolve({ id: "neon-nights" }) }); // reads no inventory
    expect(await snapshotRedis(r)).toBe(before);
    expect(getFake().calls.length).toBe(calls);
  });
});

describe("[regression] checkout resume after a declined payment", () => {
  it("closes the attempt and releases the seat when the decline is final", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const first = await createOrderRoute(
      orderRequest(guest, { eventId: "midnight-parade", tierName: "GA", quantity: 2, attemptId })
    );
    const { orderId } = await first.json();
    const order = (await r.get<Order>(`order:${orderId}`))!;
    const reserved = await r.get<number>("inventory:midnight-parade:GA");
    getFake().getPayment(order.paymentId!)!.status = "failed"; // declined; manual retry off

    const resumed = await createOrderRoute(
      orderRequest(guest, { eventId: "midnight-parade", tierName: "GA", quantity: 2, attemptId })
    );

    expect(resumed.status).toBe(409);
    expect(await resumed.json()).toMatchObject({ code: "attempt_closed", orderStatus: "failed" });
    expect(await r.get<number>("inventory:midnight-parade:GA")).toBe(reserved! + 2);
    expect(getFake().createCalls()).toHaveLength(1);
  });

  it("keeps offering the widget when the profile allows retrying the failed payment", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    await createOrderRoute(orderRequest(guest, { eventId: "midnight-parade", tierName: "GA", quantity: 1, attemptId }));
    const order = (await r.keys("order:*"))[0];
    const stored = (await r.get<Order>(order))!;
    getFake().manualRetryEnabled = true;
    getFake().getPayment(stored.paymentId!)!.status = "failed";

    const resumed = await createOrderRoute(
      orderRequest(guest, { eventId: "midnight-parade", tierName: "GA", quantity: 1, attemptId })
    );

    expect(resumed.status).toBe(200);
    expect((await resumed.json()).code).toBe("ready");
    expect((await r.get<Order>(order))!.status).toBe("pending");
  });
});
