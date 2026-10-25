import { randomUUID } from "crypto";
import { getEvent } from "@/lib/events";
import {
  GUEST_ORDER_LIST_LIMIT,
  HOLD_DURATION_MS,
  MAX_QUANTITY_PER_ORDER,
  SERVICE_FEE_RATE,
} from "@/lib/constants";
import {
  getRemainingInventory,
  InventoryStateError,
  listGuestOrders,
  peekBookingAttempt,
  peekOrder,
  recordDemandSignal,
  reserveBookingAttempt,
} from "@/lib/store";
import { newPaymentRequestId } from "@/lib/hyperswitch";
import { ensureOrderPayment } from "@/lib/booking";
import { checkRequestOrigin } from "@/lib/app-origin";
import { authenticateGuest, ownsOrder } from "@/lib/guest-session";
import {
  isValidAttemptId,
  jsonNoStore,
  originRejected,
  sessionRequired,
  toOrderView,
} from "@/lib/order-access";
import type { Order } from "@/lib/types";

export const dynamic = "force-dynamic";

// Lists the current guest's own orders, newest first (My Tickets). Reads only
// this guest's order index — no hold expiry, no provider call — and re-checks
// ownership on every order before returning its allow-listed fields.
export async function GET(request: Request) {
  const guest = await authenticateGuest(request);
  if (!guest) return sessionRequired();
  const orders = await listGuestOrders(guest.ownerHash, GUEST_ORDER_LIST_LIMIT);
  return jsonNoStore({
    orders: orders.filter((o) => ownsOrder(o, guest.ownerHash)).map(toOrderView),
  });
}

// Books a checkout attempt: reserves inventory with a 10-minute hold AND
// persists the order, then makes sure the order's provider payment exists.
// The charged amount is always computed here — tier price × quantity, plus
// a flat SERVICE_FEE_RATE service fee on that subtotal — the client only
// ever sends eventId, tierName, quantity, and its booking attemptId.
//
// The request must come from the trusted origin and already carry a valid
// guest session (POST /api/guest-session); the order is bound to that guest
// inside the atomic reservation, and this route never issues a cookie.
//
// Idempotent per booking attempt (Phase 1B.5): the same guest submitting
// the same attemptId with the same tickets gets the SAME order back — same
// hold expiry, pricing, and payment — however many times it retries, and
// concurrent submissions reserve once. Response contract (all no-store):
//   200 { code: "ready", clientSecret, ... }      booking + payment ready
//   202 { code: "processing", retryAfterMs, ... } payment still being set
//        up or its outcome is uncertain; retry the SAME attempt
//   409 { code: "attempt_conflict" }              attempt reused with
//        different tickets; nothing changed
//   409 { code: "attempt_closed", orderStatus }   the attempt's order is
//        paid, failed, or its hold lapsed; never re-booked
//   502 { code: "payment_setup_failed" }          provider definitively
//        refused; the hold was released
//   400/503 { code, error }                       invalid request, sold
//        out, or inventory/service unavailable
export async function POST(request: Request) {
  const origin = checkRequestOrigin(request);
  if (!origin.ok) return originRejected(origin);
  const guest = await authenticateGuest(request);
  if (!guest) return sessionRequired();

  const body = await request.json().catch(() => null);
  const eventId = body?.eventId;
  const tierName = body?.tierName;
  const quantity = Number(body?.quantity);
  const attemptId = body?.attemptId;

  if (!isValidAttemptId(attemptId)) {
    return jsonNoStore({ code: "invalid_request", error: "Missing or invalid booking attempt" }, 400);
  }

  const event = getEvent(eventId);
  if (!event) {
    return jsonNoStore({ code: "invalid_request", error: "Unknown event" }, 400);
  }

  const tier = event.tiers.find((t) => t.name === tierName);
  if (!tier) {
    return jsonNoStore({ code: "invalid_request", error: "Unknown ticket tier" }, 400);
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ORDER) {
    return jsonNoStore(
      { code: "invalid_request", error: `Quantity must be between 1 and ${MAX_QUANTITY_PER_ORDER}` },
      400
    );
  }

  // Friendly pre-check for a nice error message in the common case — the
  // atomic reserve below is what actually prevents overselling under real
  // concurrency. Skipped when this attempt is already bound to an order: a
  // retry must reach its own reservation even if the tier has since sold
  // out (those seats are already its). If inventory state can't be
  // established safely (e.g. a lost counter), refuse rather than guess.
  const alreadyBound = await peekBookingAttempt(guest.ownerHash, attemptId);
  if (!alreadyBound) {
    let remaining: number;
    try {
      remaining = await getRemainingInventory(event.id, tier.name, tier.totalInventory);
    } catch (err) {
      if (err instanceof InventoryStateError) {
        return jsonNoStore({ code: "inventory_unavailable", error: "Inventory temporarily unavailable" }, 503);
      }
      throw err;
    }
    if (quantity > remaining) {
      return jsonNoStore({ code: "sold_out", error: `Only ${remaining} ${tier.name} ticket(s) left` }, 400);
    }
  }

  const subtotalCents = tier.priceCents * quantity;
  const feeCents = Math.round(subtotalCents * SERVICE_FEE_RATE);
  const now = Date.now();
  const candidate: Order = {
    id: randomUUID(),
    eventId: event.id,
    tierName: tier.name,
    quantity,
    unitPriceCents: tier.priceCents,
    feeCents,
    amountCents: subtotalCents + feeCents,
    currency: "USD",
    status: "pending",
    holdExpiresAt: now + HOLD_DURATION_MS,
    createdAt: now,
    ownerHash: guest.ownerHash,
    attemptId,
    // The provider payment identity is fixed HERE, stored with the order by
    // the atomic reservation, before any provider call.
    paymentRequestId: newPaymentRequestId(),
  };

  // Atomic reserve + persist + attempt binding: either the seats are
  // reserved AND the order, its hold, its owner index entry, and its attempt
  // record are stored, or nothing is. An attempt already bound to an order
  // returns that order instead. "lost" means the counter for an initialized
  // tier is missing — refuse rather than reset to full.
  const reservation = await reserveBookingAttempt(candidate, tier.totalInventory);
  let order: Order;
  let replayed = false;
  switch (reservation.result) {
    case "created":
      order = candidate;
      // Counts toward the event page's demand signal; never blocks a booking.
      await recordDemandSignal(event.id).catch(() => {});
      break;
    case "attempt_exists": {
      const bound = reservation.boundOrderId ? await peekOrder(reservation.boundOrderId) : undefined;
      if (!bound || !ownsOrder(bound, guest.ownerHash)) {
        return jsonNoStore({ code: "error", error: "Could not load this booking" }, 500);
      }
      order = bound;
      replayed = true;
      break;
    }
    case "attempt_conflict":
      return jsonNoStore(
        {
          code: "attempt_conflict",
          error: "This booking was started with different tickets. Start a new booking to change them.",
        },
        409
      );
    case "sold_out": {
      // Lost a race with another buyer between the pre-check and here —
      // report the current count (guarding the re-read too).
      let nowRemaining = 0;
      try {
        nowRemaining = await getRemainingInventory(event.id, tier.name, tier.totalInventory);
      } catch (err) {
        if (!(err instanceof InventoryStateError)) throw err;
      }
      return jsonNoStore({ code: "sold_out", error: `Only ${nowRemaining} ${tier.name} ticket(s) left` }, 400);
    }
    case "lost":
      return jsonNoStore({ code: "inventory_unavailable", error: "Inventory temporarily unavailable" }, 503);
    default:
      // exists / conflict (fresh UUID: not expected) / error
      return jsonNoStore({ code: "error", error: "Could not create order" }, 500);
  }

  const summary = {
    orderId: order.id,
    holdExpiresAt: order.holdExpiresAt,
    feeCents: order.feeCents,
    amountCents: order.amountCents,
    replayed,
  };

  let outcome;
  try {
    outcome = await ensureOrderPayment(order);
  } catch (err) {
    // Infrastructure failure mid-way: the reservation stands and the attempt
    // stays bound, so a retry of the same attempt resumes it.
    console.error(
      `[orders] payment setup error for order ${order.id}:`,
      err instanceof Error ? err.message : "unknown"
    );
    return jsonNoStore({ code: "processing", retryAfterMs: 2000, ...summary }, 202);
  }

  switch (outcome.kind) {
    case "ready":
      // The widget needs the client secret; the provider payment id is not
      // returned — the browser navigates by the order id.
      return jsonNoStore({ code: "ready", clientSecret: outcome.clientSecret, ...summary });
    case "processing":
      return jsonNoStore({ code: "processing", retryAfterMs: 2000, ...summary }, 202);
    case "closed": {
      const lapsed = outcome.order.status === "pending";
      return jsonNoStore(
        { code: "attempt_closed", orderStatus: lapsed ? "expired" : outcome.order.status, ...summary },
        409
      );
    }
    case "failed":
      console.warn(`[orders] payment creation definitively rejected for order ${order.id}`);
      return jsonNoStore({ code: "payment_setup_failed", error: "Could not set up payment", ...summary }, 502);
  }
}
