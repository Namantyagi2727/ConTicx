import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as webhook } from "@/app/api/webhooks/hyperswitch/route";
import { HOLD_EXPIRY_BATCH_SIZE } from "@/lib/constants";
import {
  attachPaymentId,
  clearPaymentAttempt,
  getOrder,
  getReconciliationFlag,
  markPaymentAttempt,
  reserveAndCreateOrder,
  resetExpiryBudgetWindow,
} from "@/lib/store";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { createOwnedOrder, newGuest, orderRequest } from "../helpers/guest";
import { beforeRedisCommandOnce, failRedisCommand, rejectRequests, waitFor } from "../helpers/faults";
import { makeOrder } from "../helpers/orders";
import { makeTestRedis } from "../helpers/redis";
import { makeWebhookRequest, signWebhookBody } from "../helpers/webhook";
import { TEST_HYPERSWITCH_WEBHOOK_SECRET } from "../setup/constants";

// REGRESSION — Phase 1B.3: authoritative, bounded hold expiry.
//
// Converted from the INV-01 characterization, which pinned the DEFECT that
// an expired hold whose cancel was rejected with HTTP 400 was marked
// "succeeded" and kept its seat. Expiry now resolves every hold from the
// AUTHORITATIVE provider status (retrieve -> bind -> shared decision), gives
// a still-cancellable payment ONE cancellation attempt followed by a re-read,
// and never derives succeeded or released from an HTTP response code.
// Inconclusive outcomes retain the allocation and are flagged.

const EVENT_ID = "midnight-parade";
const TIER = "VIP";
const INV_KEY = `inventory:${EVENT_ID}:${TIER}`;
const r = makeTestRedis();

beforeEach(() => {
  // The expiry provider-time budget is shared per instance within a window;
  // start every test with a fresh window so tests stay independent.
  resetExpiryBudgetWindow();
});

afterEach(() => {
  delete process.env.HYPERSWITCH_TIMEOUT_MS;
  delete process.env.HOLD_EXPIRY_PROVIDER_BUDGET_MS;
});

async function createOrder(): Promise<{ orderId: string; paymentId: string }> {
  const { orderId, paymentId } = await createOwnedOrder();
  return { orderId, paymentId };
}

// Push an order's hold into the past and re-score its index entry so the
// next lazy-expiry pass selects it.
async function expireHold(orderId: string, ageMs = 60_000): Promise<void> {
  const order = (await r.get<Order>(`order:${orderId}`))!;
  const past = Date.now() - ageMs;
  order.holdExpiresAt = past;
  await r.set(`order:${orderId}`, order);
  await r.zadd("pending_holds", { score: past, member: orderId });
}

// Any store read runs one lazy-expiry pass.
async function runExpiryPass(): Promise<void> {
  await getOrder(`probe-${randomUUID()}`);
}

async function statusOf(orderId: string): Promise<string> {
  return (await r.get<Order>(`order:${orderId}`))!.status;
}

async function counter(key = INV_KEY): Promise<number> {
  return Number(await r.get<number>(key));
}

async function inIndex(orderId: string): Promise<boolean> {
  return (await r.zscore("pending_holds", orderId)) !== null;
}

function cancelCalls(): number {
  return getFake().calls.filter((c) => c.path.endsWith("/cancel")).length;
}

function paymentReads(): number {
  return getFake().calls.filter((c) => c.method === "GET" && c.path.startsWith("/payments/")).length;
}

async function inReconcileIndex(orderId: string): Promise<boolean> {
  return (await r.zscore("reconcile_needed", orderId)) !== null;
}

// An expired, pending order with NO payment id, written as raw Redis state
// (as a pre-phase "legacy" record would be): no init record, no attempt
// marker, nothing but the order, its hold entry, and the tier counter.
async function seedLegacyUnattachedExpiredOrder(): Promise<string> {
  const order = makeOrder({ holdExpiresAt: Date.now() - 60_000 });
  await r.set(`order:${order.id}`, order);
  await r.zadd("pending_holds", { score: order.holdExpiresAt, member: order.id });
  await r.set(INV_KEY, 9);
  return order.id;
}

// Same state, but created through the current atomic store path.
async function seedNewUnattachedExpiredOrder(): Promise<string> {
  const order = makeOrder({ holdExpiresAt: Date.now() - 60_000 });
  expect(await reserveAndCreateOrder(order, 10)).toBe("created");
  return order.id;
}

const isReconcileRecord = (b: string) => b.includes('"EVAL"') && b.includes("RECONCILE:");

// ---------------------------------------------------------------------------

describe("[regression] INV-01: a cancellation response never decides the outcome", () => {
  it("cancel 400 followed by an authoritative 'succeeded' marks paid and releases nothing", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "processing"; // looks cancellable
    getFake().cancelRejectsWith400 = true;
    getFake().statusAfterCancel400 = "succeeded"; // it just moved on
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("succeeded"); // from the re-read, not the 400
    expect(await counter()).toBe(afterReserve); // seat kept
  });

  it("cancel 400 followed by 'failed' retains the seat, flags it, and never marks paid", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "processing";
    getFake().cancelRejectsWith400 = true;
    getFake().statusAfterCancel400 = "failed";
    await expireHold(orderId);

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending"); // retained, not succeeded
    expect(await counter()).toBe(afterReserve); // not released either
    expect((await getReconciliationFlag(orderId))?.reason).toBe("payment_failed_retryable");
    expect(await inIndex(orderId)).toBe(false); // stops reprocessing
  });

  it("cancel 400 with the payment still processing retains, flags, and never marks paid", async () => {
    // The original INV-01 scenario: before Phase 1B.3 this became 'succeeded'.
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "processing";
    getFake().cancelRejectsWith400 = true; // status unchanged by the 400
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("cancel_then_not_final");
    expect(await inIndex(orderId)).toBe(false);
  });
});

describe("[regression] confirmed provider finality releases exactly once", () => {
  it("a successful cancellation confirmed by the re-read releases the seat once", async () => {
    const { orderId } = await createOrder(); // status requires_payment_method
    const afterReserve = await counter();
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1);
  });

  it("a payment the provider already reports 'expired' is released without a cancel", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "expired";
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(0);
    expect(await statusOf(orderId)).toBe("expired");
    expect(await counter()).toBe(afterReserve + 1);
  });

  it("two expiry passes over the same hold release at most once (sequential and concurrent)", async () => {
    const { orderId } = await createOrder();
    const afterReserve = await counter();
    await expireHold(orderId);

    await Promise.all([runExpiryPass(), runExpiryPass()]);
    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1); // never +2
    expect(cancelCalls()).toBe(1);
  });
});

describe("[regression] inconclusive evidence retains the allocation", () => {
  it("cancellation succeeded but the re-read is inconclusive: retained and flagged", async () => {
    const { orderId } = await createOrder();
    const afterReserve = await counter();
    getFake().getFailsAfterCancel = true; // first read fine, re-read 500s
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe(
      "cancel_issued_retrieve_inconclusive"
    );
    // Kept in the index so a later pass can confirm once the provider answers.
    expect(await inIndex(orderId)).toBe(true);
  });

  for (const [label, setup] of [
    ["non-JSON", () => (getFake().getReturnsNonJson = true)],
    ["5xx", () => (getFake().getReturns500 = true)],
    [
      "timeout",
      () => {
        getFake().delayMs = 300;
        process.env.HYPERSWITCH_TIMEOUT_MS = "50";
      },
    ],
  ] as const) {
    it(`a ${label} provider read guesses no terminal outcome and makes no cancel`, async () => {
      const { orderId } = await createOrder();
      const afterReserve = await counter();
      await expireHold(orderId);
      setup();

      await runExpiryPass();

      expect(cancelCalls()).toBe(0);
      expect(await statusOf(orderId)).toBe("pending");
      expect(await counter()).toBe(afterReserve);
      expect(await inIndex(orderId)).toBe(true); // transient: retried next pass
    });
  }

  it("a binding mismatch guesses no terminal outcome; retained and flagged", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    getFake().getPayment(paymentId)!.amount = 1; // != stored amountCents
    await expireHold(orderId);

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending"); // not paid despite 'succeeded'
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("amount_mismatch");
    expect(await inIndex(orderId)).toBe(false);
  });
});

describe("[regression] expired order without an attached payment id is never released", () => {
  it("retains and flags a LEGACY pending order with no payment id and no attempt marker", async () => {
    const orderId = await seedLegacyUnattachedExpiredOrder();
    const before = await counter();

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending"); // not expired
    expect(await counter()).toBe(before); // marker absence released nothing
    expect((await getReconciliationFlag(orderId))?.reason).toBe("no_payment_id_unresolved");
    expect(await inIndex(orderId)).toBe(false); // moved out of pending work...
    expect(await inReconcileIndex(orderId)).toBe(true); // ...into the reconciliation set
  });

  it("retains and flags a NEW pending order with no payment id and no attempt marker", async () => {
    const orderId = await seedNewUnattachedExpiredOrder();
    const before = await counter();

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(before);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("no_payment_id_unresolved");
    expect(await inReconcileIndex(orderId)).toBe(true);
  });

  it("records the attempt marker only as a diagnostic in the reason", async () => {
    const orderId = await seedNewUnattachedExpiredOrder();
    await markPaymentAttempt(orderId);
    const before = await counter();

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(before);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("no_payment_id_attempt_marked");
  });

  it("does not act on a stale snapshot: attach + marker clear landing mid-expiry is preserved", async () => {
    // Creation in progress: order persisted, attempt marker set, payment id
    // not yet attached. Expiry reads the order (no payment id); then, right
    // before expiry's next command (the marker check), creation attaches the
    // payment id and clears the marker. Pre-correction, expiry saw "no
    // marker" and released the seat from its stale read.
    const orderId = await seedNewUnattachedExpiredOrder();
    await markPaymentAttempt(orderId);
    const before = await counter();
    const dispose = beforeRedisCommandOnce(
      (b) => b.includes('"EXISTS"') && b.includes(`PAYMENT_ATTEMPT:${orderId.toUpperCase()}`),
      async () => {
        expect(await attachPaymentId(orderId, "pay_attached_late")).toBe("ok");
        await clearPaymentAttempt(orderId);
      }
    );
    try {
      await runExpiryPass();
    } finally {
      dispose();
    }

    const stored = (await r.get<Order>(`order:${orderId}`))!;
    expect(stored.paymentId).toBe("pay_attached_late"); // attachment not overwritten
    expect(stored.status).toBe("pending"); // status not overwritten
    expect(await counter()).toBe(before); // nothing released
    expect(await getReconciliationFlag(orderId)).toBeNull(); // HAS_PAYMENT: no flag
    expect(await inIndex(orderId)).toBe(true); // still pending work...

    // ...so a later pass resolves it from verified provider evidence.
    getFake().seedPayment({
      payment_id: "pay_attached_late",
      status: "succeeded",
      amount: 11000,
      currency: "USD",
      metadata: { orderId },
    });
    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(before);
  });

  it("a later verified payment outcome still resolves a retained, flagged order", async () => {
    const orderId = await seedLegacyUnattachedExpiredOrder();
    const before = await counter();
    await runExpiryPass();
    expect(await inReconcileIndex(orderId)).toBe(true);

    // The payment id is attached later and a verified success arrives.
    expect(await attachPaymentId(orderId, "pay_found_later")).toBe("ok");
    getFake().seedPayment({
      payment_id: "pay_found_later",
      status: "succeeded",
      amount: 11000,
      currency: "USD",
      metadata: { orderId },
    });
    const raw = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event_type: "payment_succeeded",
      content: { object: { payment_id: "pay_found_later" } },
    });
    const res = await webhook(
      makeWebhookRequest(raw, signWebhookBody(raw, TEST_HYPERSWITCH_WEBHOOK_SECRET))
    );

    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(before); // seat kept, never released
  });

  it("the order route clears the attempt marker once the payment id is attached", async () => {
    const { orderId } = await createOrder();
    expect(await r.exists(`payment_attempt:${orderId}`)).toBe(0);
  });
});

describe("[regression] inconclusive cancellation outcomes are recorded", () => {
  it("a cancel timeout retains, flags, keeps the hold eligible, and a later pass resolves it", async () => {
    const { orderId, paymentId } = await createOrder(); // requires_payment_method
    const afterReserve = await counter();
    getFake().cancelDelayMs = 400; // the provider still applies it, late
    process.env.HYPERSWITCH_TIMEOUT_MS = "100";
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(1);
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("cancel_outcome_unknown");
    expect(await inIndex(orderId)).toBe(true); // eligible for a lazy retry
    expect(await inReconcileIndex(orderId)).toBe(true); // and discoverable

    // The cancellation was in fact processed; the next pass reads that.
    await waitFor(() => getFake().getPayment(paymentId)!.status === "cancelled");
    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("failed");
    expect(await counter()).toBe(afterReserve + 1);
  });

  it("a cancel transport rejection retains and flags without guessing", async () => {
    const { orderId } = await createOrder();
    const afterReserve = await counter();
    await expireHold(orderId);
    const dispose = rejectRequests((url) => url.endsWith("/cancel"));
    try {
      await runExpiryPass();
    } finally {
      dispose();
    }

    expect(cancelCalls()).toBe(0); // never reached the provider
    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect((await getReconciliationFlag(orderId))?.reason).toBe("cancel_outcome_unknown");
    expect(await inIndex(orderId)).toBe(true);
  });

  it("if recording the cancel-outcome flag fails, the hold stays in pending work untouched", async () => {
    const { orderId } = await createOrder();
    const afterReserve = await counter();
    await expireHold(orderId);
    const scoreBefore = await r.zscore("pending_holds", orderId);
    const undoReject = rejectRequests((url) => url.endsWith("/cancel"));
    const undoFail = failRedisCommand(isReconcileRecord);
    try {
      await expect(runExpiryPass()).resolves.toBeUndefined(); // the read itself succeeds
    } finally {
      undoFail();
      undoReject();
    }

    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(afterReserve);
    expect(await getReconciliationFlag(orderId)).toBeNull(); // not recorded...
    expect(await inReconcileIndex(orderId)).toBe(false);
    expect(await r.zscore("pending_holds", orderId)).toBe(scoreBefore); // ...so not moved
  });

  it("if recording fails for a payment-less order, it is not dequeued", async () => {
    const orderId = await seedLegacyUnattachedExpiredOrder();
    const before = await counter();
    const dispose = failRedisCommand(isReconcileRecord);
    try {
      await runExpiryPass();
    } finally {
      dispose();
    }

    expect(await statusOf(orderId)).toBe("pending");
    expect(await counter()).toBe(before);
    expect(await getReconciliationFlag(orderId)).toBeNull();
    expect(await inIndex(orderId)).toBe(true); // still discoverable as pending work
  });
});

describe("[regression] webhook success racing expiry", () => {
  it("expiry that finds the payment already succeeded marks paid and releases nothing", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    await expireHold(orderId);

    await runExpiryPass();

    expect(cancelCalls()).toBe(0);
    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(afterReserve);
  });

  it("a webhook success that lands first leaves expiry a no-op with consistent inventory", async () => {
    const { orderId, paymentId } = await createOrder();
    const afterReserve = await counter();
    getFake().getPayment(paymentId)!.status = "succeeded";
    await expireHold(orderId);

    const raw = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event_type: "payment_succeeded",
      content: { object: { payment_id: paymentId } },
    });
    const res = await webhook(
      makeWebhookRequest(raw, signWebhookBody(raw, TEST_HYPERSWITCH_WEBHOOK_SECRET))
    );
    expect(res.status).toBe(200);

    await runExpiryPass();

    expect(await statusOf(orderId)).toBe("succeeded");
    expect(await counter()).toBe(afterReserve);
    expect(cancelCalls()).toBe(0);
    expect(await inIndex(orderId)).toBe(false);
  });
});

describe("[regression] lazy expiry work is bounded", () => {
  it(`processes at most ${HOLD_EXPIRY_BATCH_SIZE} expired holds per pass with a backlog`, async () => {
    const gaKey = `inventory:${EVENT_ID}:GA`;
    await r.set(gaKey, 10);
    const backlog = HOLD_EXPIRY_BATCH_SIZE + 2;
    const base = Date.now() - 60_000;
    for (let i = 0; i < backlog; i++) {
      const order = makeOrder({ tierName: "GA", holdExpiresAt: base + i });
      await r.set(`order:${order.id}`, order);
      await r.zadd("pending_holds", { score: base + i, member: order.id });
    }

    // These seeded orders have no payment id, so each processed one is
    // retained and moved to the reconciliation set — never released.
    await runExpiryPass();
    expect(await r.zcard("pending_holds")).toBe(backlog - HOLD_EXPIRY_BATCH_SIZE);
    expect(await r.zcard("reconcile_needed")).toBe(HOLD_EXPIRY_BATCH_SIZE);
    expect(await counter(gaKey)).toBe(10);

    await runExpiryPass();
    expect(await r.zcard("pending_holds")).toBe(0);
    expect(await r.zcard("reconcile_needed")).toBe(backlog);
    expect(await counter(gaKey)).toBe(10);
  });

  it("each held order costs at most three provider calls in a pass (read, cancel, re-read)", async () => {
    const { orderId } = await createOrder();
    getFake().getFailsAfterCancel = true; // forces the longest path
    await expireHold(orderId);
    const before = getFake().calls.length;

    await runExpiryPass();

    expect(getFake().calls.length - before).toBe(3);
  });
});

describe("[regression] expiry provider-time budget", () => {
  // Creates n orders FIRST (each creation runs its own expiry pass), then
  // makes each payment authoritatively succeeded and expires every hold.
  async function expiredSucceededOrders(n: number): Promise<string[]> {
    const created: { orderId: string; paymentId: string }[] = [];
    for (let i = 0; i < n; i++) created.push(await createOrder());
    for (const { orderId, paymentId } of created) {
      getFake().getPayment(paymentId)!.status = "succeeded";
      await expireHold(orderId);
    }
    return created.map((c) => c.orderId);
  }

  it("a slow provider exhausts the pass budget without starting the remaining work", async () => {
    const ids = await expiredSucceededOrders(4);
    const before = await counter();
    getFake().delayMs = 400;
    process.env.HOLD_EXPIRY_PROVIDER_BUDGET_MS = "1000";
    const reads0 = paymentReads();

    const t0 = Date.now();
    await runExpiryPass();
    const elapsed = Date.now() - t0;

    // 400 + 400 ms spent; 200 ms left is under the 250 ms minimum, so the
    // third read is never started.
    expect(paymentReads() - reads0).toBe(2);
    const statuses = await Promise.all(ids.map(statusOf));
    expect(statuses.filter((s) => s === "succeeded")).toHaveLength(2);
    const untouched = ids.filter((_, i) => statuses[i] === "pending");
    expect(untouched).toHaveLength(2);
    for (const id of untouched) {
      expect(await inIndex(id)).toBe(true); // left for a later pass
      expect(await getReconciliationFlag(id)).toBeNull(); // not misreported
    }
    expect(await counter()).toBe(before);
    expect(elapsed).toBeLessThan(1000 + 500);
  });

  it("caps each provider call's timeout at the remaining budget", async () => {
    const [orderId] = await expiredSucceededOrders(1);
    getFake().delayMs = 3000; // far beyond the budget (helper default is 10 s)
    process.env.HOLD_EXPIRY_PROVIDER_BUDGET_MS = "600";

    const t0 = Date.now();
    await runExpiryPass();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1500); // aborted near 600 ms
    expect(await statusOf(orderId)).toBe("pending");
    expect(await inIndex(orderId)).toBe(true); // transient: kept for later
  });

  it("the several expiry passes of ONE request share one budget", async () => {
    const ids = await expiredSucceededOrders(4);
    getFake().delayMs = 400;
    process.env.HOLD_EXPIRY_PROVIDER_BUDGET_MS = "1000";
    const guest = await newGuest(); // no provider calls
    const reads0 = paymentReads();

    // Order creation runs an expiry pass in the availability pre-check AND
    // another inside reserveAndCreateOrder. Without a shared budget each
    // pass would spend a full budget (4 reads); shared, they make 2 in total.
    const res = await createOrderRoute(orderRequest(guest));
    expect(res.status).toBe(200);
    // Phase 1B.5: the booking itself also retrieves its OWN new payment id
    // once before creating it; that read is not expiry work, so only reads of
    // other payments count here.
    const booked = (await r.get<Order>(`order:${(await res.json()).orderId}`))!;
    const ownReads = getFake().calls.filter(
      (c) => c.method === "GET" && c.path === `/payments/${booked.paymentRequestId}`
    ).length;
    expect(ownReads).toBe(1);
    expect(paymentReads() - reads0 - ownReads).toBe(2);

    // A later window (a later request) picks up the remaining holds.
    resetExpiryBudgetWindow();
    await runExpiryPass();
    expect(paymentReads() - reads0 - ownReads).toBe(4);
    for (const id of ids) expect(await statusOf(id)).toBe("succeeded");
  });

  it("a hold whose reads keep timing out is deferred behind others instead of starving them", async () => {
    const slow = await createOrder();
    const fast = await createOrder();
    getFake().getDelayMsFor.set(slow.paymentId, 2000); // every read of it times out
    getFake().getPayment(fast.paymentId)!.status = "succeeded";
    await expireHold(slow.orderId, 120_000); // older: selected first
    await expireHold(fast.orderId, 60_000);
    process.env.HOLD_EXPIRY_PROVIDER_BUDGET_MS = "600";

    await runExpiryPass(); // slow read consumes the whole budget
    expect(await statusOf(fast.orderId)).toBe("pending");
    expect(await inIndex(slow.orderId)).toBe(true);

    resetExpiryBudgetWindow();
    await runExpiryPass(); // slow was re-queued behind fast, so fast goes first

    expect(await statusOf(fast.orderId)).toBe("succeeded");
    expect(await statusOf(slow.orderId)).toBe("pending");
    expect(await inIndex(slow.orderId)).toBe(true);
  });
});
