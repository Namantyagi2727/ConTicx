import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as readOrderRoute } from "@/app/api/orders/[id]/route";
import { newPaymentRequestId } from "@/lib/hyperswitch";
import {
  attachPaymentId,
  getReconciliationFlag,
  reserveBookingAttempt,
  transitionOrder,
  updateOrderStatus,
} from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { failRedisCommand, rejectRequests } from "../helpers/faults";
import { makeTestRedis, snapshotRedis } from "../helpers/redis";
import { makeOrder } from "../helpers/orders";
import { guestRequest, newGuest, orderRequest } from "../helpers/guest";
import { hashGuestCredential } from "@/lib/guest-session";

// REGRESSION — Phase 1B.5: idempotent booking attempts and safe payment
// creation. Every case drives the real order route (or the real store) against
// local Redis and the fake provider, and asserts stored orders, attempt
// records, inventory, holds, owner indexes, payment associations, and the
// provider calls the fake recorded — not only HTTP responses.
//
// The fake models the provider contract this phase relies on: a caller-chosen
// payment_id, a duplicate create rejected with 400/HE_01 without returning the
// existing payment (upstream implementation, not documented), retrieval by id.
// That does not establish parity with the hosted provider.

const r = makeTestRedis();
const INV_KEY = "inventory:midnight-parade:VIP";
const VIP = { eventId: "midnight-parade", tierName: "VIP" };

const envBackup = { ...process.env };
afterEach(() => {
  for (const k of ["HYPERSWITCH_TIMEOUT_MS", "BOOKING_PAYMENT_LEASE_MS"]) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

function book(cookie: string, attemptId: string, quantity = 1, extra: Record<string, unknown> = {}) {
  return createOrderRoute(orderRequest(cookie, { ...VIP, quantity, attemptId, ...extra }));
}

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function orders(): Promise<Order[]> {
  const keys = await r.keys("order:*");
  return Promise.all(keys.map(async (k) => (await r.get<Order>(k))!));
}

async function inventory(): Promise<number> {
  return Number(await r.get(INV_KEY));
}

function attemptKey(cookie: string, attemptId: string) {
  return `booking_attempt:${hashGuestCredential(cookie.split("=")[1])}:${attemptId}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("[regression] one booking attempt → one owned order and reservation", () => {
  it("collapses concurrent identical submissions into one order, index entry, decrement, and payment", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();

    const responses = await Promise.all(Array.from({ length: 6 }, () => book(guest, attemptId, 2)));
    const bodies = await Promise.all(responses.map(bodyOf));

    expect(new Set(bodies.map((b) => b.orderId)).size).toBe(1);
    for (const res of responses) expect([200, 202]).toContain(res.status);
    const all = await orders();
    expect(all).toHaveLength(1);
    expect(await r.zcard(`guest_orders:${all[0].ownerHash}`)).toBe(1);
    expect(await inventory()).toBe(8);
    expect(await r.zcard("pending_holds")).toBe(1);
    expect(getFake().allPayments()).toHaveLength(1);
    expect(getFake().allPayments()[0].payment_id).toBe(all[0].paymentRequestId);

    // A follow-up retry of the same attempt is ready, still one of everything.
    const again = await book(guest, attemptId, 2);
    expect(again.status).toBe(200);
    expect((await bodyOf(again)).orderId).toBe(all[0].id);
    expect(await orders()).toHaveLength(1);
    expect(getFake().allPayments()).toHaveLength(1);
  });

  it("replays after a lost HTTP response: same order, hold, pricing, payment; nothing new", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const first = await bodyOf(await book(guest, attemptId, 2));
    const original = (await orders())[0];
    const creates = getFake().createCalls().length;
    await sleep(25); // a later retry, e.g. after a reload

    const res = await book(guest, attemptId, 2);
    const replay = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(replay).toMatchObject({
      code: "ready",
      replayed: true,
      orderId: original.id,
      holdExpiresAt: original.holdExpiresAt,
      amountCents: original.amountCents,
      feeCents: original.feeCents,
      clientSecret: first.clientSecret,
    });
    const stored = (await orders())[0];
    expect(stored).toEqual(original); // createdAt, hold, pricing, payment untouched
    expect(stored.paymentId).toBe(original.paymentRequestId);
    expect(getFake().createCalls()).toHaveLength(creates);
    expect(await inventory()).toBe(8);
  });

  it("refuses the same attempt with changed inputs, changing nothing", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    await book(guest, attemptId, 2);
    const before = await snapshotRedis(r);
    const calls = getFake().calls.length;

    for (const extra of [{ quantity: 3 }, { tierName: "GA" }, { eventId: "neon-nights", tierName: "GA" }]) {
      const res = await createOrderRoute(orderRequest(guest, { ...VIP, quantity: 2, attemptId, ...extra }));
      expect(res.status).toBe(409);
      expect((await bodyOf(res)).code).toBe("attempt_conflict");
    }

    expect(await snapshotRedis(r)).toBe(before);
    expect(getFake().calls.length).toBe(calls);
  });

  it("keeps attempts per guest: another guest's identical id neither finds nor claims the order", async () => {
    const guestA = await newGuest();
    const guestB = await newGuest();
    const attemptId = randomUUID();
    const a = await bodyOf(await book(guestA, attemptId, 1));
    const aAttempt = await r.get(attemptKey(guestA, attemptId));

    const resB = await book(guestB, attemptId, 1);
    const b = await bodyOf(resB);

    // B got its OWN independent booking — never A's order, secret, or hold.
    expect(resB.status).toBe(200);
    expect(b.orderId).not.toBe(a.orderId);
    expect(b.clientSecret).not.toBe(a.clientSecret);
    expect(await r.get(attemptKey(guestA, attemptId))).toEqual(aAttempt);
    const readA = await readOrderRoute(guestRequest(`/api/orders/${a.orderId}`, { cookie: guestB }), {
      params: Promise.resolve({ id: String(a.orderId) }),
    });
    expect(readA.status).toBe(404);
    const owners = new Set((await orders()).map((o) => o.ownerHash));
    expect(owners.size).toBe(2);
  });

  it("books deliberately separate identical attempts separately", async () => {
    const guest = await newGuest();
    const first = await bodyOf(await book(guest, randomUUID(), 1));
    const second = await bodyOf(await book(guest, randomUUID(), 1));

    expect(first.orderId).not.toBe(second.orderId);
    expect(await orders()).toHaveLength(2);
    expect(getFake().allPayments()).toHaveLength(2);
    expect(await inventory()).toBe(8);
  });

  it("resumes a reserved order whose process stopped before payment creation", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const ownerHash = hashGuestCredential(guest.split("=")[1]);
    // Reserve exactly as the route would, then "crash" before the provider call.
    const reserved = makeOrder({ ownerHash, attemptId, quantity: 1, paymentRequestId: newPaymentRequestId() });
    expect((await reserveBookingAttempt(reserved, 10)).result).toBe("created");
    expect(getFake().createCalls()).toHaveLength(0);

    const res = await book(guest, attemptId, 1);
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.orderId).toBe(reserved.id);
    expect(body.holdExpiresAt).toBe(reserved.holdExpiresAt);
    const creates = getFake().createCalls();
    expect(creates).toHaveLength(1);
    expect((creates[0].body as { payment_id: string }).payment_id).toBe(reserved.paymentRequestId);
    expect((await r.get<Order>(`order:${reserved.id}`))!.paymentId).toBe(reserved.paymentRequestId);
    expect(await inventory()).toBe(9);
  });
});

describe("[regression] payment creation under uncertain outcomes", () => {
  it("provider created it but the response was lost: retains, flags, then adopts by id — one payment", async () => {
    process.env.HYPERSWITCH_TIMEOUT_MS = "300";
    getFake().createResponseDelayMs = 800; // stored at once, answered too late
    const guest = await newGuest();
    const attemptId = randomUUID();

    const res = await book(guest, attemptId, 1);
    const body = await bodyOf(res);
    const order = (await orders())[0];

    expect(res.status).toBe(202);
    expect(body.code).toBe("processing");
    expect(order.status).toBe("pending");
    expect(order.paymentId).toBeUndefined();
    expect(await inventory()).toBe(9); // reservation kept
    expect((await getReconciliationFlag(order.id))?.reason).toBe("payment_create_uncertain_transport");
    expect(getFake().getPayment(order.paymentRequestId!)).toBeDefined(); // it DID get created

    await sleep(600); // let the slow response finish
    getFake().createResponseDelayMs = 0;
    const retry = await book(guest, attemptId, 1);

    expect(retry.status).toBe(200);
    expect((await bodyOf(retry)).orderId).toBe(order.id);
    expect(getFake().allPayments()).toHaveLength(1);
    expect(getFake().createCalls()).toHaveLength(1); // retrieved, not re-created
    expect((await r.get<Order>(`order:${order.id}`))!.paymentId).toBe(order.paymentRequestId);
    expect(await inventory()).toBe(9);
  });

  it("provider answered 500 after creating it: retry adopts the same payment", async () => {
    getFake().createFailsAfterInsert = true;
    const guest = await newGuest();
    const attemptId = randomUUID();

    expect((await book(guest, attemptId)).status).toBe(202);
    getFake().createFailsAfterInsert = false;
    const retry = await book(guest, attemptId);

    expect(retry.status).toBe(200);
    expect(getFake().allPayments()).toHaveLength(1);
    expect(getFake().createCalls()).toHaveLength(1);
  });

  it("the create never reached the provider: retry creates under the SAME id", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const restore = rejectRequests((url) => url.endsWith("/payments"));
    const res = await book(guest, attemptId);
    restore();
    const order = (await orders())[0];

    expect(res.status).toBe(202);
    expect(getFake().allPayments()).toHaveLength(0);
    expect(await inventory()).toBe(9);

    const retry = await book(guest, attemptId);
    expect(retry.status).toBe(200);
    const created = getFake().createCalls();
    expect(created).toHaveLength(1);
    expect((created[0].body as { payment_id: string }).payment_id).toBe(order.paymentRequestId);
  });

  it("provider created it but the local association failed: retry adopts it, never a second payment", async () => {
    // With Redis failing, the lease release can fail too; the lease then
    // lapses after its TTL (shortened here) and the retry resolves by id.
    process.env.BOOKING_PAYMENT_LEASE_MS = "200";
    const guest = await newGuest();
    const attemptId = randomUUID();
    const restore = failRedisCommand((body) => body.includes("ORDER['PAYMENTID'] = PAYMENTID"));
    const res = await book(guest, attemptId);
    restore();
    const order = (await orders())[0];

    expect(res.status).toBe(202);
    expect(order.paymentId).toBeUndefined();
    expect(getFake().allPayments()).toHaveLength(1);
    expect(await inventory()).toBe(9);

    await sleep(250);
    const retry = await book(guest, attemptId);
    expect(retry.status).toBe(200);
    expect(getFake().allPayments()).toHaveLength(1);
    expect(getFake().createCalls()).toHaveLength(1);
    expect((await r.get<Order>(`order:${order.id}`))!.paymentId).toBe(order.paymentRequestId);
  });

  it("a definitive rejection fails the order and releases its seats; the attempt then stays closed", async () => {
    getFake().createRejection = {
      status: 400,
      body: { error: { type: "invalid_request", code: "IR_06", message: "invalid amount" } },
    };
    const guest = await newGuest();
    const attemptId = randomUUID();

    const res = await book(guest, attemptId, 2);
    expect(res.status).toBe(502);
    expect((await bodyOf(res)).code).toBe("payment_setup_failed");
    const order = (await orders())[0];
    expect(order.status).toBe("failed");
    expect(await inventory()).toBe(10); // released
    expect(getFake().allPayments()).toHaveLength(0);

    getFake().createRejection = null;
    const creates = getFake().createCalls().length;
    const replay = await book(guest, attemptId, 2);
    expect(replay.status).toBe(409);
    expect(await bodyOf(replay)).toMatchObject({ code: "attempt_closed", orderStatus: "failed" });
    expect(await orders()).toHaveLength(1);
    expect(getFake().createCalls()).toHaveLength(creates);
    expect(await inventory()).toBe(10);
  });
});

describe("[regression] concurrent and stale payment workers", () => {
  it("a retry during an in-flight creation answers processing without a provider call", async () => {
    getFake().createResponseDelayMs = 400;
    const guest = await newGuest();
    const attemptId = randomUUID();

    const first = book(guest, attemptId);
    await sleep(150); // the first request holds the lease, mid-create
    const callsBefore = getFake().calls.length;
    const during = await book(guest, attemptId);

    expect(during.status).toBe(202);
    expect(getFake().calls.length).toBe(callsBefore); // no read, no create
    expect((await first).status).toBe(200);
    expect(getFake().allPayments()).toHaveLength(1);
  });

  it("a stale worker that resumes after another progressed the payment changes nothing", async () => {
    process.env.BOOKING_PAYMENT_LEASE_MS = "100";
    getFake().createResponseDelayMs = 600; // worker A is slow to hear back
    const guest = await newGuest();
    const attemptId = randomUUID();

    const workerA = book(guest, attemptId);
    await sleep(250); // A's lease has lapsed; B claims and finishes first
    const workerB = await book(guest, attemptId);
    expect(workerB.status).toBe(200);
    const afterB = (await orders())[0];
    expect(afterB.paymentId).toBe(afterB.paymentRequestId);

    const resA = await workerA; // A's (late) success for the SAME id
    expect(resA.status).toBe(200);
    expect((await orders())[0]).toEqual(afterB); // attach was a no-op
    expect(getFake().allPayments()).toHaveLength(1);
    expect(getFake().createCalls()).toHaveLength(1); // B retrieved; it never re-created
    expect(await inventory()).toBe(9);
  });

  it("a stale definitive rejection cannot fail an order whose payment is attached", async () => {
    const order = makeOrder({ quantity: 2 });
    await reserveBookingAttempt(order, 10);
    expect(await attachPaymentId(order.id, order.paymentRequestId!)).toBe("ok");
    const before = await snapshotRedis(r);

    const result = await transitionOrder(order.id, "pending", "failed", true, { requireNoPaymentId: true });

    expect(result).toBe("has_payment");
    expect(await snapshotRedis(r)).toBe(before);
  });
});

describe("[regression] closed attempts and malformed state", () => {
  it("replaying a paid attempt reserves and creates nothing", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const first = await bodyOf(await book(guest, attemptId));
    await updateOrderStatus(String(first.orderId), "succeeded");
    const before = await snapshotRedis(r);
    const calls = getFake().calls.length;

    const replay = await book(guest, attemptId);

    expect(replay.status).toBe(409);
    expect(await bodyOf(replay)).toMatchObject({ code: "attempt_closed", orderStatus: "succeeded" });
    expect(await snapshotRedis(r)).toBe(before);
    expect(getFake().calls.length).toBe(calls);
  });

  it("replaying an attempt whose hold lapsed does not create a payment or a new booking", async () => {
    const guest = await newGuest();
    const attemptId = randomUUID();
    const ownerHash = hashGuestCredential(guest.split("=")[1]);
    const reserved = makeOrder({ ownerHash, attemptId, holdExpiresAt: Date.now() + 50 });
    await reserveBookingAttempt(reserved, 10);
    await sleep(80);

    const replay = await book(guest, attemptId);

    expect(replay.status).toBe(409);
    expect(await bodyOf(replay)).toMatchObject({ code: "attempt_closed", orderStatus: "expired" });
    expect(getFake().createCalls()).toHaveLength(0);
    expect(await orders()).toHaveLength(1);
  });

  it("a wrong-type attempt record makes the reservation fail before any write", async () => {
    const order = makeOrder();
    await r.hset(`booking_attempt:${order.ownerHash}:${order.attemptId}`, { not: "a string" });
    const before = await snapshotRedis(r);

    expect((await reserveBookingAttempt(order, 10)).result).toBe("error");

    expect(await snapshotRedis(r)).toBe(before);
    expect(await r.exists(INV_KEY, `order:${order.id}`, `guest_orders:${order.ownerHash}`)).toBe(0);
    expect(await r.zscore("pending_holds", order.id)).toBeNull();
  });

  it("refuses an order without a well-formed attempt or payment identity", async () => {
    for (const overrides of [
      { attemptId: undefined },
      { attemptId: "not-a-uuid" },
      { paymentRequestId: undefined },
      { paymentRequestId: "pay_short" },
      { paymentRequestId: "PAY_" + "a".repeat(26) },
    ]) {
      expect((await reserveBookingAttempt(makeOrder(overrides), 10)).result).toBe("error");
    }
    expect(await r.keys("*")).toEqual([]);
  });

  it("rejects a booking request without a valid attempt id before any work", async () => {
    const guest = await newGuest();
    const before = await snapshotRedis(r);
    for (const attemptId of [undefined, "", "abc", randomUUID().toUpperCase()]) {
      const res = await createOrderRoute(
        guestRequest("/api/orders", { method: "POST", cookie: guest, body: { ...VIP, quantity: 1, attemptId } })
      );
      expect(res.status).toBe(400);
    }
    expect(await snapshotRedis(r)).toBe(before);
    expect(getFake().calls).toHaveLength(0);
  });
});
