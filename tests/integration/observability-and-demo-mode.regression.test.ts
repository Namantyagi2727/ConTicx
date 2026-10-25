import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as createOrderRoute, GET as listOrdersRoute } from "@/app/api/orders/route";
import { GET as readOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as orderStatusRoute } from "@/app/api/orders/[id]/status/route";
import { POST as guestSessionRoute } from "@/app/api/guest-session/route";
import { POST as webhookRoute } from "@/app/api/webhooks/hyperswitch/route";
import EventPage from "@/app/events/[id]/page";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { TEST_HYPERSWITCH_WEBHOOK_SECRET } from "../setup/constants";
import { failRedisCommand } from "../helpers/faults";
import { makeTestRedis, snapshotRedis } from "../helpers/redis";
import { createOwnedOrder, guestRequest, newGuest, orderRequest } from "../helpers/guest";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";

// REGRESSION — closeout: structured request logs on the booking, order-status,
// and webhook routes (with sensitive-data exclusion), and the browse-only demo
// mode, which must refuse every booking/order/webhook entry point and keep the
// event page from touching inventory or the provider.

const r = makeTestRedis();

type Line = Record<string, unknown>;
let lines: Line[] = [];
let raw: string[] = [];

beforeEach(() => {
  lines = [];
  raw = [];
  const capture = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    raw.push(text);
    try {
      lines.push(JSON.parse(text));
    } catch {
      /* not a structured line */
    }
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

function requestLines(op: string): Line[] {
  return lines.filter((l) => l.event === "request" && l.op === op);
}

// Everything secret that the flow handles must be absent from every log line.
function expectNoSecrets(secrets: (string | undefined)[]) {
  const all = raw.join("\n");
  for (const s of secrets) if (s) expect(all).not.toContain(s);
  expect(all).not.toMatch(/conticx_guest=|_secret_|"ownerHash"|"clientSecret"|"attemptId"/);
}

describe("[regression] structured request logs", () => {
  it("logs a booking with request id, outcome, and duration — and no secrets", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const res = await createOrderRoute(
      orderRequest(guest, { eventId: "midnight-parade", tierName: "VIP", quantity: 1, attemptId })
    );
    const body = await res.json();
    const order = (await r.get<Order>(`order:${body.orderId}`))!;

    const [line] = requestLines("booking.create");
    expect(line).toMatchObject({
      level: "info",
      outcome: "ready",
      status: 200,
      orderId: order.id,
      eventId: "midnight-parade",
      replayed: false,
    });
    expect(line.requestId).toMatch(/^req_/);
    expect(res.headers.get("x-request-id")).toBe(line.requestId);
    expect(typeof line.durationMs).toBe("number");
    expect(line.requestId).not.toBe(attemptId);
    expectNoSecrets([guest.split("=")[1], order.ownerHash, body.clientSecret, attemptId, order.paymentRequestId]);
  });

  it("logs failures with a safe outcome and no order details for unauthorized callers", async () => {
    const owned = await createOwnedOrder();
    lines = [];
    raw = [];
    const stranger = await newGuest();

    const noSession = await createOrderRoute(orderRequest(null));
    const foreign = await orderStatusRoute(
      guestRequest(`/api/orders/${owned.orderId}/status`, { cookie: stranger }),
      { params: Promise.resolve({ id: owned.orderId }) }
    );

    expect(noSession.status).toBe(401);
    expect(requestLines("booking.create")[0]).toMatchObject({ outcome: "unauthorized", status: 401 });
    expect(foreign.status).toBe(404);
    const statusLine = requestLines("order.status")[0];
    expect(statusLine).toMatchObject({ outcome: "not_found", status: 404 });
    expect(statusLine).not.toHaveProperty("orderId");
    expect(foreign.headers.get("x-request-id")).toBe(statusLine.requestId);
    expectNoSecrets([stranger.split("=")[1], owned.cookie.split("=")[1]]);
  });

  it("logs an owned status refresh with the order's outcome", async () => {
    const { orderId, paymentId, cookie } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    lines = [];
    await orderStatusRoute(guestRequest(`/api/orders/${orderId}/status`, { cookie }), {
      params: Promise.resolve({ id: orderId }),
    });
    expect(requestLines("order.status")[0]).toMatchObject({ orderId, outcome: "succeeded", status: 200 });
  });

  it("logs an infrastructure error by class only, never its message", async () => {
    const guest = await newGuest();
    const restore = failRedisCommand((b) => b.includes("PAYMENT_CREATE_LEASE"));
    const res = await createOrderRoute(orderRequest(guest));
    restore();
    expect(res.status).toBe(202);
    const [line] = requestLines("booking.create");
    expect(line).toMatchObject({ outcome: "processing", reason: "payment_setup_error", errorKind: "UpstashError" });
    expect(raw.join("\n")).not.toContain("injected redis failure");
  });

  it("logs webhooks without bodies or signatures, and the event id only once authenticated", async () => {
    const { paymentId } = await createOwnedOrder();
    getFake().getPayment(paymentId)!.status = "succeeded";
    lines = [];
    raw = [];
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({
      event_id: eventId,
      event_type: "payment_succeeded",
      content: { object: { payment_id: paymentId } },
    });
    const signature = signWebhookBody(body, TEST_HYPERSWITCH_WEBHOOK_SECRET);

    await webhookRoute(makeWebhookRequest(body, "0".repeat(128)));
    await webhookRoute(makeWebhookRequest(body, signature));

    const [forged, valid] = requestLines("webhook.receive");
    expect(forged).toMatchObject({ outcome: "unauthorized", status: 401, reason: "signature_mismatch" });
    expect(forged).not.toHaveProperty("webhookEventId");
    expect(valid).toMatchObject({ status: 200, webhookEventId: eventId });
    const all = raw.join("\n");
    expect(all).not.toContain(signature);
    expect(all).not.toContain("payment_succeeded");
    expect(all).not.toContain(paymentId);
  });

  it("keeps booking behaviour unchanged when the log sink throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    const guest = await newGuest();
    const res = await createOrderRoute(orderRequest(guest));
    expect(res.status).toBe(200);
    expect(await r.keys("order:*")).toHaveLength(1);
    expect(getFake().allPayments()).toHaveLength(1);
  });
});

describe("[regression] browse-only demo mode", () => {
  beforeEach(() => {
    process.env.CONTICX_MODE = "browse-only";
  });
  afterEach(() => {
    process.env.CONTICX_MODE = "full";
  });

  it("refuses every booking, order, ticket, and webhook entry point before any work", async () => {
    // An expired hold any expiry pass would act on, created in full mode.
    process.env.CONTICX_MODE = "full";
    const { orderId, cookie } = await createOwnedOrder();
    const order = (await r.get<Order>(`order:${orderId}`))!;
    order.holdExpiresAt = Date.now() - 60_000;
    await r.set(`order:${orderId}`, order);
    await r.zadd("pending_holds", { score: order.holdExpiresAt, member: orderId });
    process.env.CONTICX_MODE = "browse-only";
    const before = await snapshotRedis(r);
    const calls = getFake().calls.length;
    const params = { params: Promise.resolve({ id: orderId }) };
    const body = JSON.stringify({ event_id: "evt_x", event_type: "payment_succeeded", content: { object: { payment_id: "pay_x" } } });

    const responses = [
      await guestSessionRoute(guestRequest("/api/guest-session", { method: "POST" })),
      await createOrderRoute(orderRequest(cookie)),
      await listOrdersRoute(guestRequest("/api/orders", { cookie })),
      await readOrderRoute(guestRequest(`/api/orders/${orderId}`, { cookie }), params),
      await orderStatusRoute(guestRequest(`/api/orders/${orderId}/status`, { cookie }), params),
      await webhookRoute(makeWebhookRequest(body, signWebhookBody(body, TEST_HYPERSWITCH_WEBHOOK_SECRET))),
    ];

    for (const res of responses) {
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("browse_only");
    }
    expect(await snapshotRedis(r)).toBe(before);
    expect(getFake().calls.length).toBe(calls);
  });

  it("treats an unset or unknown mode as browse-only", async () => {
    for (const value of [undefined, "", "FULL", "true"]) {
      if (value === undefined) delete process.env.CONTICX_MODE;
      else process.env.CONTICX_MODE = value;
      const res = await guestSessionRoute(guestRequest("/api/guest-session", { method: "POST" }));
      expect(res.status).toBe(503);
    }
    expect(await r.keys("*")).toEqual([]);
  });

  it("renders event pages without reading inventory or calling the provider", async () => {
    process.env.CONTICX_MODE = "full";
    const { orderId } = await createOwnedOrder();
    const order = (await r.get<Order>(`order:${orderId}`))!;
    order.holdExpiresAt = Date.now() - 60_000;
    await r.set(`order:${orderId}`, order);
    await r.zadd("pending_holds", { score: order.holdExpiresAt, member: orderId });
    await r.del("inventory:neon-nights:GA", "inventory_init:neon-nights:GA");
    process.env.CONTICX_MODE = "browse-only";
    const before = await snapshotRedis(r);
    const calls = getFake().calls.length;

    await EventPage({ params: Promise.resolve({ id: "neon-nights" }) });

    expect(await snapshotRedis(r)).toBe(before); // no expiry, no counter seeded
    expect(getFake().calls.length).toBe(calls);

    // Control: the same page in full mode does read (and seed) inventory.
    process.env.CONTICX_MODE = "full";
    await EventPage({ params: Promise.resolve({ id: "neon-nights" }) });
    expect(await r.exists("inventory:neon-nights:GA")).toBe(1);
  });
});
