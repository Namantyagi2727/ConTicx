// Orders and tier inventory counters live in Upstash Redis, not
// in-memory. This is deliberately split from lib/events.ts, which
// stays a hardcoded module:
//
//   - Orders and inventory are read-modify-write state that changes
//     on every purchase, and must be visible to every serverless
//     instance handling this app — a Hyperswitch webhook can land on
//     a completely different instance than the one that created the
//     order, so anything kept in that instance's process memory would
//     silently never see the update. Shared storage is a hard
//     requirement here, not an optimization.
//   - The event catalog is static and read-only. There's nothing to
//     synchronize, so a database round trip would only add latency
//     for no correctness benefit.
//
// Orders are stored as JSON values keyed by order id. Inventory is
// tracked as a plain Redis integer per (eventId, tierName), mutated
// with atomic INCRBY/DECRBY rather than derived by scanning orders —
// see reserveInventory for why that atomicity is what actually
// prevents overselling.

import { redis } from "./redis";
import { hyperswitchFetch } from "./hyperswitch";
import type { Order, OrderStatus } from "./types";

// ZSET of still-pending order ids, scored by holdExpiresAt. Lets reap
// find "which holds expired" with a single ZRANGE instead of scanning
// every order key (Redis has no cheap way to list all order:* keys).
const PENDING_HOLDS_KEY = "pending_holds";

function orderKey(id: string) {
  return `order:${id}`;
}

function inventoryKey(eventId: string, tierName: string) {
  return `inventory:${eventId}:${tierName}`;
}

// Raw read, no reap side effect. Used internally by updateOrderStatus
// and by reap itself — both already know a fresh reap pass doesn't
// need to run again on their behalf, and in updateOrderStatus's case,
// going through the public getOrder (which reaps first) would
// deadlock: reap awaits updateOrderStatus, which would be awaiting the
// same in-flight reap pass to finish first.
async function readOrder(id: string): Promise<Order | undefined> {
  const order = await redis.get<Order>(orderKey(id));
  return order ?? undefined;
}

async function saveOrder(order: Order): Promise<void> {
  await redis.set(orderKey(order.id), order);
  if (order.status === "pending") {
    await redis.zadd(PENDING_HOLDS_KEY, {
      score: order.holdExpiresAt,
      member: order.id,
    });
  } else {
    await redis.zrem(PENDING_HOLDS_KEY, order.id);
  }
}

// Seeds the inventory counter to the tier's total the first time it's
// touched. SETNX is atomic: if two requests race to initialize the
// same tier, only one write wins and the other silently no-ops, so
// both still end up decrementing against the same correctly-seeded
// counter rather than one clobbering the other's seed.
async function ensureInventoryInitialized(key: string, totalInventory: number) {
  await redis.setnx(key, totalInventory);
}

async function releaseInventory(eventId: string, tierName: string, quantity: number) {
  await redis.incrby(inventoryKey(eventId, tierName), quantity);
}

// Cancels the Hyperswitch intent for a genuinely-expired pending hold
// before releasing its inventory — see the comment on the loop body
// for the race this guards against. Guarded by a single in-flight
// promise: getRemainingInventory is called once per tier, and
// Promise.all-ing those calls (as the event page does for GA + VIP
// together) would otherwise start two concurrent reap passes that
// both see the same expired order and both race to cancel the same
// payment_id — whichever cancel response loses that race gets
// rejected by Hyperswitch and would incorrectly read as "already
// paid". Joining concurrent callers onto the same pass removes that
// race entirely. Note this guard is per serverless instance, not
// global — Redis's atomicity is what keeps two *different* instances
// reaping at the same moment from double-cancelling, same as it keeps
// two concurrent reservations from overselling.
let reapInFlight: Promise<void> | null = null;

async function reapExpiredHolds(): Promise<void> {
  if (reapInFlight) return reapInFlight;

  reapInFlight = (async () => {
    const now = Date.now();
    const expiredIds = await redis.zrange<string[]>(PENDING_HOLDS_KEY, "-inf", now, {
      byScore: true,
    });

    for (const orderId of expiredIds) {
      const order = await readOrder(orderId);
      if (!order || order.status !== "pending") {
        // Already resolved (webhook, another instance's reap pass, or
        // a stale entry) — drop it so we stop re-checking it.
        await redis.zrem(PENDING_HOLDS_KEY, orderId);
        continue;
      }

      if (!order.paymentId) {
        await updateOrderStatus(order.id, "expired");
        continue;
      }

      // The race this guards against: a shopper's payment can succeed
      // at Hyperswitch in the same moment their 10-minute hold ticks
      // over (a slow bank auth, a redirect flow, a browser tab left
      // open). If we freed the inventory purely on the clock, we
      // could resell a seat that was just paid for. So cancelling the
      // intent always comes first, and the order's fate depends on
      // what Hyperswitch says:
      //   - cancel succeeds -> the intent was still in a cancellable
      //     state, so it was genuinely unpaid. Safe to expire and
      //     release the hold.
      //   - cancel is rejected with 400 (IR_16, "cannot cancel from
      //     status X") -> the intent moved past a cancellable state,
      //     which for a payment we created can only mean it succeeded
      //     or is mid-flight. Treat the order as paid and keep its
      //     inventory reserved.
      //   - cancel fails for any other reason (network error, 401,
      //     5xx) -> inconclusive. Leave the order pending and retry
      //     on the next reap instead of guessing either way.
      try {
        const response = await hyperswitchFetch(
          `/payments/${order.paymentId}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({ cancellation_reason: "hold_expired" }),
          }
        );

        if (response.ok) {
          await updateOrderStatus(order.id, "expired");
        } else if (response.status === 400) {
          await updateOrderStatus(order.id, "succeeded");
        }
      } catch {
        // Network/infra error — inconclusive, leave pending.
      }
    }
  })();

  try {
    await reapInFlight;
  } finally {
    reapInFlight = null;
  }
}

export async function getRemainingInventory(
  eventId: string,
  tierName: string,
  totalInventory: number
): Promise<number> {
  await reapExpiredHolds();
  const key = inventoryKey(eventId, tierName);
  await ensureInventoryInitialized(key, totalInventory);
  const remaining = await redis.get<number>(key);
  return Math.max(0, remaining ?? totalInventory);
}

// Atomically reserves `quantity` units. DECRBY is a single atomic
// Redis command, so concurrent reservations are serialized by Redis
// itself rather than racing in application code — this is what
// actually prevents overselling, not the friendly pre-check in the
// route handler (that's just a nicer error message in the common
// case, not a safety mechanism). If the decrement takes the counter
// below zero, the reservation is rolled back with a compensating
// increment and the caller is told no.
export async function reserveInventory(
  eventId: string,
  tierName: string,
  quantity: number,
  totalInventory: number
): Promise<boolean> {
  await reapExpiredHolds();
  const key = inventoryKey(eventId, tierName);
  await ensureInventoryInitialized(key, totalInventory);

  const remaining = await redis.decrby(key, quantity);
  if (remaining < 0) {
    await redis.incrby(key, quantity); // undo
    return false;
  }
  return true;
}

export async function createOrder(order: Order): Promise<void> {
  await reapExpiredHolds();
  await saveOrder(order);
}

export async function getOrder(id: string): Promise<Order | undefined> {
  await reapExpiredHolds();
  return readOrder(id);
}

// Direct status transitions driven by an authoritative source (the
// payment-status route or the webhook handler). Idempotent by
// construction: it only acts on an order that's still "pending", so
// calling it twice for the same event — a redelivered webhook, or the
// payment-status route and the webhook both reconciling the same
// payment — is a safe no-op the second time, not a double-release of
// inventory. This also means a terminal state, once reached, never
// gets overwritten by a later conflicting signal.
export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  const order = await readOrder(id);
  if (!order) return;
  if (order.status !== "pending") return;

  order.status = status;
  await saveOrder(order);

  if (status === "failed" || status === "expired") {
    await releaseInventory(order.eventId, order.tierName, order.quantity);
  }
}

// Marks a succeeded order refunded and releases its inventory back to
// the tier. Only acts on an order that's still "succeeded" — calling
// this twice (a duplicate/retried refund request) is a safe no-op the
// second time (returns false), not a double release of inventory.
// This is the primary idempotency guard the refund route relies on;
// Hyperswitch's own refund API is a second line of defense (it
// rejects a second full refund against the same payment with
// "refund amount exceeds amount captured"), but that's not something
// this route depends on to stay correct.
export async function markOrderRefunded(id: string): Promise<boolean> {
  const order = await readOrder(id);
  if (!order || order.status !== "succeeded") return false;

  order.status = "refunded";
  await saveOrder(order);
  await releaseInventory(order.eventId, order.tierName, order.quantity);
  return true;
}
