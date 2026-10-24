import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { POST as guestSession } from "@/app/api/guest-session/route";
import { GET as listOrders, POST as createOrder } from "@/app/api/orders/route";
import { GET as readOrder } from "@/app/api/orders/[id]/route";
import { GET as orderStatus } from "@/app/api/orders/[id]/status/route";
import { POST as refund } from "@/app/api/orders/[id]/refund/route";
import { GET as paymentLookup } from "@/app/api/payments/[id]/route";
import { POST as paymentCreate } from "@/app/api/payments/create/route";
import { POST as webhook } from "@/app/api/webhooks/hyperswitch/route";
import AdminPage from "@/app/admin/page";
import { GUEST_SESSION_TTL_SECONDS } from "@/lib/constants";
import { hashGuestCredential } from "@/lib/guest-session";
import { reserveAndCreateOrder } from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { TEST_APP_ORIGIN, TEST_HYPERSWITCH_WEBHOOK_SECRET } from "../setup/constants";
import { makeTestRedis } from "../helpers/redis";
import { makeOrder } from "../helpers/orders";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";
import {
  cookieFromSetCookie,
  createOwnedOrder,
  guestRequest,
  newGuest,
  orderRequest,
} from "../helpers/guest";

// REGRESSION — Phase 1B.4 guest ownership and protected order access.
// Before this phase any caller who knew an order id (or a provider payment
// id) could read the order, trigger reconciliation, and refund it (SEC-02).
// These tests drive the real routes against local Redis and the fake
// provider and assert on raw stored state and recorded provider calls.

const r = makeTestRedis();
const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;

// Every key with its type and full raw content, so "no side effects" can be
// asserted as "the whole store is byte-for-byte unchanged".
async function snapshot(): Promise<string> {
  const dump = await r.eval(
    `local out = {}
     local keys = redis.call('KEYS', '*')
     table.sort(keys)
     for _, k in ipairs(keys) do
       local t = redis.call('TYPE', k).ok
       local v
       if t == 'string' then v = redis.call('GET', k)
       elseif t == 'zset' then v = table.concat(redis.call('ZRANGE', k, 0, -1, 'WITHSCORES'), ',')
       else v = '?' end
       table.insert(out, k .. '|' .. t .. '|' .. v)
     end
     return out`,
    [],
    []
  );
  return (dump as string[]).join("\n");
}

function providerCalls(): number {
  return getFake().calls.length;
}

function read(id: string, cookie?: string | null) {
  return readOrder(guestRequest(`/api/orders/${id}`, { cookie }), {
    params: Promise.resolve({ id }),
  });
}

function status(id: string, cookie?: string | null) {
  return orderStatus(guestRequest(`/api/orders/${id}/status`, { cookie }), {
    params: Promise.resolve({ id }),
  });
}

function list(cookie?: string | null) {
  return listOrders(guestRequest("/api/orders", { cookie }));
}

// An expired hold sitting in the pending index: any code path that runs lazy
// expiry would read its payment from the provider and change the store.
async function seedExpiredHold(): Promise<{ orderId: string; paymentId: string }> {
  const created = await createOwnedOrder();
  const order = (await r.get<Order>(`order:${created.orderId}`))!;
  order.holdExpiresAt = Date.now() - 60_000;
  await r.set(`order:${created.orderId}`, order);
  await r.zadd("pending_holds", { score: order.holdExpiresAt, member: created.orderId });
  getFake().getPayment(created.paymentId)!.status = "succeeded";
  return created;
}

// A well-formed credential the server never issued.
function forgedCookie(): string {
  return `conticx_guest=${randomBytes(32).toString("base64url")}`;
}

describe("[regression] guest session issuance", () => {
  it("issues an HttpOnly, SameSite=Lax, host-only cookie and stores only its hash", async () => {
    const res = await guestSession(guestRequest("/api/guest-session", { method: "POST" }));
    const setCookie = res.headers.get("set-cookie")!;
    const credential = cookieFromSetCookie(setCookie).split("=")[1];

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    const attrs = setCookie.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).toContain("path=/");
    expect(attrs).toContain(`max-age=${GUEST_SESSION_TTL_SECONDS}`);
    expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
    expect(attrs).not.toContain("secure"); // the test origin is plain http

    // The body never carries the credential, and neither does Redis.
    expect(JSON.stringify(await res.json())).not.toContain(credential);
    const store = await snapshot();
    expect(store).not.toContain(credential);
    expect(store).toContain(`guest_session:${hashGuestCredential(credential)}`);
  });

  it("reuses a valid session instead of replacing it, renewing its lifetime", async () => {
    const cookie = await newGuest();
    const key = `guest_session:${hashGuestCredential(cookie.split("=")[1])}`;
    await r.expire(key, 60);

    const again = await Promise.all([newGuest(cookie), newGuest(cookie), newGuest(cookie)]);

    expect(again).toEqual([cookie, cookie, cookie]);
    expect(await r.ttl(key)).toBeGreaterThan(GUEST_SESSION_TTL_SECONDS - 60);
  });

  it("replaces a credential the server never issued, and that credential owns nothing", async () => {
    const forged = forgedCookie();
    const issued = await newGuest(forged);
    expect(issued).not.toBe(forged);

    const res = await createOrder(orderRequest(forged));
    expect(res.status).toBe(401);
    expect(await r.keys("order:*")).toEqual([]);
  });

  it("keeps one guest identity across multiple bookings", async () => {
    const cookie = await newGuest();
    const first = await createOwnedOrder(cookie);
    const second = await createOwnedOrder(await newGuest(cookie)); // re-established before booking

    const a = (await r.get<Order>(`order:${first.orderId}`))!;
    const b = (await r.get<Order>(`order:${second.orderId}`))!;
    expect(second.cookie).toBe(cookie);
    expect(a.ownerHash).toBe(hashGuestCredential(cookie.split("=")[1]));
    expect(b.ownerHash).toBe(a.ownerHash);
  });

  it("refuses a booking without an established session, before any work", async () => {
    const before = await snapshot();
    const calls = providerCalls();

    const res = await createOrder(orderRequest(null));

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull(); // booking never issues ownership
    expect(providerCalls()).toBe(calls);
    expect(await snapshot()).toBe(before);
  });
});

describe("[regression] order access is limited to the owning guest", () => {
  it("lets guest A read A's order with allow-listed fields and no-store", async () => {
    const { orderId, cookie } = await createOwnedOrder();

    const res = await read(orderId, cookie);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.id).toBe(orderId);
    expect(body.ownerHash).toBeUndefined();
    expect(body.paymentId).toBeUndefined();
  });

  it("gives guest B the same generic 404 as a missing order, for reads and status", async () => {
    const { orderId } = await createOwnedOrder();
    await seedExpiredHold(); // any expiry pass would touch the provider
    const guestB = await newGuest();
    getFake().calls.length = 0;
    const before = await snapshot();

    const otherRead = await read(orderId, guestB);
    const otherStatus = await status(orderId, guestB);
    const missing = await read(randomUUID(), guestB);

    for (const res of [otherRead, otherStatus, missing]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Order not found" });
    }
    expect(providerCalls()).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it("does not let another guest's status poll reach the provider or reconcile", async () => {
    const { orderId, paymentId } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const guestB = await newGuest();
    const calls = providerCalls();

    await status(orderId, guestB);

    expect(providerCalls()).toBe(calls);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("pending");
  });

  it("refuses missing, malformed, and unknown credentials with no side effects at all", async () => {
    const { orderId } = await seedExpiredHold();
    const inventory = await r.get(INV_KEY);
    const before = await snapshot();
    const calls = providerCalls();

    for (const cookie of [null, "conticx_guest=not-a-credential", "conticx_guest=", forgedCookie()]) {
      expect((await read(orderId, cookie)).status).toBe(401);
      expect((await status(orderId, cookie)).status).toBe(401);
      expect((await list(cookie)).status).toBe(401);
    }

    // No provider call, no expiry pass, no reconciliation, no write.
    expect(providerCalls()).toBe(calls);
    expect(await r.get(INV_KEY)).toEqual(inventory);
    expect(await snapshot()).toBe(before);
  });

  it("keeps legacy orders without an owner inaccessible to every guest", async () => {
    const legacy = makeOrder({ paymentId: "pay_legacy" });
    delete legacy.ownerHash;
    await r.set(`order:${legacy.id}`, legacy);
    const guest = await newGuest();
    const before = await snapshot();
    const calls = providerCalls();

    expect((await read(legacy.id, guest)).status).toBe(404);
    expect((await status(legacy.id, guest)).status).toBe(404);
    expect((await (await list(guest)).json()).orders).toEqual([]);
    expect(providerCalls()).toBe(calls);
    expect(await snapshot()).toBe(before);
  });

  it("answers a malformed order id with the generic 404", async () => {
    const guest = await newGuest();
    for (const id of ["../../payments", "order:1", "x".repeat(300), randomUUID().toUpperCase()]) {
      const res = await read(id, guest);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Order not found" });
    }
  });

  it("lists only the current guest's orders", async () => {
    const guestA = await newGuest();
    const guestB = await newGuest();
    const a1 = await createOwnedOrder(guestA);
    const a2 = await createOwnedOrder(guestA);
    const b1 = await createOwnedOrder(guestB);

    const resA = await list(guestA);
    const resB = await list(guestB);
    const idsA = (await resA.json()).orders.map((o: { id: string }) => o.id);
    const bodyB = await resB.json();

    expect(resA.headers.get("cache-control")).toBe("no-store");
    expect(idsA.sort()).toEqual([a1.orderId, a2.orderId].sort());
    expect(bodyB.orders.map((o: { id: string }) => o.id)).toEqual([b1.orderId]);
    expect(JSON.stringify(bodyB)).not.toMatch(/ownerHash|paymentId|pay_/);
  });
});

describe("[regression] ownership is bound inside the atomic reservation", () => {
  async function storeState(order: Order) {
    return {
      order: await r.get(`order:${order.id}`),
      inventory: await r.get(INV_KEY),
      holds: await r.zrange("pending_holds", 0, -1),
      snapshot: await snapshot(),
    };
  }

  it("rejects a different-owner replay of an existing order without mutation", async () => {
    const order = makeOrder();
    expect(await reserveAndCreateOrder(order, 10)).toBe("created");
    const before = await storeState(order);

    const replay = { ...order, ownerHash: randomBytes(32).toString("hex") };
    expect(await reserveAndCreateOrder(replay, 10)).toBe("conflict");

    expect(await storeState(order)).toEqual(before);
    expect(await r.exists(`guest_orders:${replay.ownerHash}`)).toBe(0);
  });

  it("does not let a guest claim a legacy ownerless order by replaying it", async () => {
    const legacy = makeOrder({ status: "succeeded", paymentId: "pay_legacy" });
    delete legacy.ownerHash;
    await r.set(`order:${legacy.id}`, legacy);
    await r.set(INV_KEY, 5);
    const before = await storeState(legacy);

    const claim = { ...legacy, status: "pending" as const, ownerHash: randomBytes(32).toString("hex") };
    expect(await reserveAndCreateOrder(claim, 10)).toBe("conflict");

    expect(await storeState(legacy)).toEqual(before);
  });

  it("refuses to create an order without a well-formed owner", async () => {
    for (const ownerHash of [undefined, "", "ABC", "g".repeat(64)]) {
      const order = makeOrder({ ownerHash });
      expect(await reserveAndCreateOrder(order, 10)).toBe("error");
    }
    expect(await r.keys("order:*")).toEqual([]);
    expect(await r.exists(INV_KEY)).toBe(0);
  });

  it("indexes the order under its owner in the same step", async () => {
    const order = makeOrder();
    await reserveAndCreateOrder(order, 10);
    expect(await r.zscore(`guest_orders:${order.ownerHash}`, order.id)).toBe(order.createdAt);
  });
});

describe("[regression] browser mutations require the trusted origin", () => {
  const badOrigins: (string | null)[] = [
    null, // no Origin header
    "null",
    "not a url",
    "http://localhost/path",
    "http://localhost:3000",
    "https://localhost",
    "http://evil.example",
  ];

  it("rejects guest-session creation from any other origin without issuing anything", async () => {
    for (const origin of badOrigins) {
      const res = await guestSession(guestRequest("/api/guest-session", { method: "POST", origin }));
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(await r.keys("*")).toEqual([]);
  });

  it("rejects order creation from any other origin with no reservation or provider call", async () => {
    const guest = await newGuest();
    const before = await snapshot();
    const calls = providerCalls();

    for (const origin of badOrigins) {
      expect((await createOrder(orderRequest(guest, undefined, origin))).status).toBe(403);
    }

    expect(providerCalls()).toBe(calls);
    expect(await snapshot()).toBe(before);
  });

  it("does not trust a forwarded or Host header in place of the configured origin", async () => {
    const req = new Request("http://evil.example/api/guest-session", {
      method: "POST",
      headers: { origin: "http://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect((await guestSession(req)).status).toBe(403);
  });

  describe("with APP_ORIGIN unset", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.APP_ORIGIN;
      delete process.env.APP_ORIGIN;
    });
    afterEach(() => {
      process.env.APP_ORIGIN = saved;
    });

    it("fails closed for both mutations", async () => {
      const session = await guestSession(
        guestRequest("/api/guest-session", { method: "POST", origin: TEST_APP_ORIGIN })
      );
      const order = await createOrder(orderRequest(forgedCookie()));
      expect(session.status).toBe(503);
      expect(order.status).toBe(503);
      expect(await r.keys("*")).toEqual([]);
    });
  });
});

describe("[regression] refunds, payment lookups, and the organizer view are disabled", () => {
  it("refuses a refund for the owning guest with zero provider or store side effects", async () => {
    const { orderId } = await createOwnedOrder();
    const order = (await r.get<Order>(`order:${orderId}`))!;
    order.status = "succeeded";
    await r.set(`order:${orderId}`, order);
    const before = await snapshot();
    const calls = providerCalls();

    const res = await refund();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Online refunds are not available." });
    expect(providerCalls()).toBe(calls);
    expect(await snapshot()).toBe(before);
  });

  it("answers the retired payment routes without contacting the provider", async () => {
    const { paymentId } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const before = await snapshot();
    const calls = providerCalls();

    expect((await paymentLookup()).status).toBe(410);
    expect((await paymentCreate()).status).toBe(410);

    expect(providerCalls()).toBe(calls);
    expect(await snapshot()).toBe(before);
  });

  it("renders the organizer view as not-found without reading anything", async () => {
    await seedExpiredHold();
    const before = await snapshot();
    const calls = providerCalls();

    expect(() => AdminPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);

    expect(providerCalls()).toBe(calls);
    expect(await snapshot()).toBe(before);
  });
});

describe("[regression] provider webhooks stay independent of guest cookies", () => {
  it("applies an authenticated webhook to a guest's order with no cookie present", async () => {
    const { orderId, paymentId } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    const body = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event_type: "payment_succeeded",
      content: { object: { payment_id: paymentId } },
    });

    const res = await webhook(
      makeWebhookRequest(body, signWebhookBody(body, TEST_HYPERSWITCH_WEBHOOK_SECRET))
    );

    expect(res.status).toBe(200);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("succeeded");
  });
});
