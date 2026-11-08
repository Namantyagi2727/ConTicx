import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as orderStatusRoute } from "@/app/api/orders/[id]/status/route";
import { POST as guestSessionRoute } from "@/app/api/guest-session/route";
import { POST as webhookRoute } from "@/app/api/webhooks/hyperswitch/route";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { TEST_HYPERSWITCH_WEBHOOK_SECRET } from "../setup/constants";
import { makeTestRedis } from "../helpers/redis";
import { cookieFromSetCookie, guestRequest, orderRequest } from "../helpers/guest";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";

// REGRESSION — public sandbox demo: the usage limits that bound repeated
// public booking and status traffic without breaking idempotent retries or
// provider webhooks.

const r = makeTestRedis();

function from(address: string, req: Request): Request {
  req.headers.set("x-forwarded-for", address);
  return req;
}

async function guestFrom(address: string): Promise<string> {
  const res = await guestSessionRoute(from(address, guestRequest("/api/guest-session", { method: "POST" })));
  expect(res.status).toBe(200);
  return cookieFromSetCookie(res.headers.get("set-cookie"));
}

function book(cookie: string, address: string, attemptId = randomUUID()) {
  return createOrderRoute(
    from(address, orderRequest(cookie, { eventId: "neon-nights", tierName: "GA", quantity: 1, attemptId }))
  );
}

describe("[regression] public demo usage limits", () => {
  beforeEach(() => {
    delete process.env.CONTICX_RATE_LIMITS;
  });
  afterEach(() => {
    process.env.CONTICX_RATE_LIMITS = "off";
    delete process.env.CONTICX_DEMO_BOOKINGS_PER_HOUR;
  });

  it("bounds new bookings per guest, but always resumes an existing attempt", async () => {
    const guest = await guestFrom("198.51.100.1");
    const firstAttempt = randomUUID();
    expect((await book(guest, "198.51.100.1", firstAttempt)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await book(guest, "198.51.100.1")).status).toBe(200);

    const refused = await book(guest, "198.51.100.1");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await refused.json();
    expect(body.code).toBe("rate_limited");
    expect(body.error).toMatch(/try again/i);
    expect(await r.keys("order:*")).toHaveLength(6); // the refused attempt booked nothing
    expect(getFake().createCalls()).toHaveLength(6);

    const retry = await book(guest, "198.51.100.1", firstAttempt);
    expect(retry.status).toBe(200);
    expect((await retry.json()).replayed).toBe(true);
    expect(getFake().createCalls()).toHaveLength(6);
  });

  it("bounds overall demo bookings across fresh guests and addresses", async () => {
    process.env.CONTICX_DEMO_BOOKINGS_PER_HOUR = "2";
    expect((await book(await guestFrom("198.51.100.1"), "198.51.100.1")).status).toBe(200);
    expect((await book(await guestFrom("198.51.100.2"), "198.51.100.2")).status).toBe(200);

    const third = await book(await guestFrom("198.51.100.3"), "198.51.100.3");
    expect(third.status).toBe(429);
    expect(await r.keys("order:*")).toHaveLength(2);
  });

  it("bounds fresh guest sessions per client address, not renewals", async () => {
    let last = "";
    for (let i = 0; i < 20; i++) last = await guestFrom("203.0.113.9");
    const refused = await guestSessionRoute(
      from("203.0.113.9", guestRequest("/api/guest-session", { method: "POST" }))
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("set-cookie")).toBeNull();

    // A browser that already has a session keeps renewing it.
    const renewed = await guestSessionRoute(
      from("203.0.113.9", guestRequest("/api/guest-session", { method: "POST", cookie: last }))
    );
    expect(renewed.status).toBe(200);
    // Another address is unaffected.
    await guestFrom("203.0.113.10");
  });

  it("bounds status refreshes per guest without limiting webhooks", async () => {
    const guest = await guestFrom("198.51.100.4");
    const res = await book(guest, "198.51.100.4");
    const { orderId } = await res.json();
    const poll = () =>
      orderStatusRoute(guestRequest(`/api/orders/${orderId}/status`, { cookie: guest }), {
        params: Promise.resolve({ id: orderId }),
      });
    const reads = () => getFake().calls.filter((c) => c.method === "GET" && c.path.startsWith("/payments/")).length;
    const before = reads();
    for (let i = 0; i < 40; i++) expect((await poll()).status).toBe(200);
    const limited = await poll();
    expect(limited.status).toBe(429);
    const providerReads = reads() - before;

    const order = (await r.get<Order>(`order:${orderId}`))!;
    getFake().getPayment(order.paymentId!)!.status = "succeeded";
    const body = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event_type: "payment_succeeded",
      content: { object: { payment_id: order.paymentId } },
    });
    const hook = await webhookRoute(makeWebhookRequest(body, signWebhookBody(body, TEST_HYPERSWITCH_WEBHOOK_SECRET)));
    expect(hook.status).toBe(200);
    expect((await r.get<Order>(`order:${orderId}`))!.status).toBe("succeeded");
    expect(providerReads).toBe(40); // the refused poll did not reach the provider
  });
});
