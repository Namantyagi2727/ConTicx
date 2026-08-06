// Deliberate prototype scope: orders and inventory holds live in a
// single in-memory Map, not a database. Attaching it to globalThis
// keeps it stable across Next.js dev hot-reloads and warm serverless
// invocations, but it resets on a cold start or redeploy — fine for a
// live demo, not for production.

import { hyperswitchFetch } from "./hyperswitch";
import type { Order, OrderStatus } from "./types";

const g = globalThis as unknown as { __conticxOrders?: Map<string, Order> };
const orders: Map<string, Order> = g.__conticxOrders ?? (g.__conticxOrders = new Map());

// Flips any pending order whose hold has expired to "expired", freeing
// its inventory for other buyers — but only after confirming with
// Hyperswitch that the payment intent is actually cancellable.
//
// The race this guards against: a shopper's payment can succeed at
// Hyperswitch in the same moment their 10-minute hold ticks over (a
// slow bank auth, a redirect flow, a browser tab left open). If we
// freed the inventory purely on the clock, we could resell a seat
// that was just paid for. So cancelling the intent always comes
// first, and the order's fate depends on what Hyperswitch says:
//
//   - cancel succeeds -> the intent was still in a cancellable state
//     (requires_payment_method, requires_confirmation, etc), so it
//     was genuinely unpaid. Safe to expire and release the hold.
//   - cancel is rejected with 400 (IR_16, "cannot cancel from status
//     X") -> the intent has moved past a cancellable state, which for
//     a payment we created can only mean it succeeded or is mid-flight
//     ("processing"). Treat the order as paid and leave its inventory
//     held. If it later turns out to have actually failed, the
//     payment-status route or the webhook handler will flip it to
//     "failed" and release the hold then — those are the authoritative
//     sources for terminal status, not this best-effort cleanup pass.
//   - cancel fails for any other reason (network error, 401, 5xx) ->
//     inconclusive. Leave the order pending and retry on the next
//     reap instead of guessing either way.
//
// Run lazily on every read/write instead of a background timer, since
// this runs on serverless.
//
// Guarded by a single in-flight promise: getRemainingInventory is
// called once per tier, and Promise.all-ing those calls (as the event
// page does for GA + VIP together) would otherwise start two
// concurrent reap passes that both see the same expired order as
// "pending" and both race to cancel the same payment_id. Whichever
// cancel response lands second then gets rejected by Hyperswitch (400,
// already cancelled) and — following the "cancel failed" branch below
// — incorrectly flips the order to "succeeded", permanently locking up
// inventory for a payment that was never actually paid. Joining
// concurrent callers onto the same pass instead of starting a new one
// each time removes the double-cancel race entirely.
let reapInFlight: Promise<void> | null = null;

async function reapExpiredHolds(): Promise<void> {
  if (reapInFlight) return reapInFlight;

  reapInFlight = (async () => {
    const now = Date.now();
    const toReap = Array.from(orders.values()).filter(
      (order) => order.status === "pending" && order.holdExpiresAt < now
    );

    for (const order of toReap) {
      if (!order.paymentId) {
        order.status = "expired";
        continue;
      }

      try {
        const response = await hyperswitchFetch(
          `/payments/${order.paymentId}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({ cancellation_reason: "hold_expired" }),
          }
        );

        if (response.ok) {
          order.status = "expired";
        } else if (response.status === 400) {
          order.status = "succeeded";
        }
        // else: inconclusive — leave "pending" for the next reap pass.
      } catch {
        // Network/infra error — inconclusive, leave "pending".
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
  let taken = 0;
  for (const order of orders.values()) {
    if (
      order.eventId === eventId &&
      order.tierName === tierName &&
      (order.status === "pending" || order.status === "succeeded")
    ) {
      taken += order.quantity;
    }
  }
  return Math.max(0, totalInventory - taken);
}

export async function createOrder(order: Order) {
  await reapExpiredHolds();
  orders.set(order.id, order);
}

export async function getOrder(id: string): Promise<Order | undefined> {
  await reapExpiredHolds();
  return orders.get(id);
}

// Direct status transitions driven by an authoritative source (the
// payment-status route or the webhook handler) — no reap here, since
// the caller already knows the real status and reaping would just
// spend time cancelling unrelated orders.
export function updateOrderStatus(id: string, status: OrderStatus) {
  const order = orders.get(id);
  if (order) order.status = status;
}
