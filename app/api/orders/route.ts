import { randomUUID } from "crypto";
import { getEvent } from "@/lib/events";
import {
  GUEST_ORDER_LIST_LIMIT,
  HOLD_DURATION_MS,
  MAX_QUANTITY_PER_ORDER,
  SERVICE_FEE_RATE,
} from "@/lib/constants";
import {
  attachPaymentId,
  clearPaymentAttempt,
  getRemainingInventory,
  InventoryStateError,
  listGuestOrders,
  markPaymentAttempt,
  recordDemandSignal,
  reserveAndCreateOrder,
  updateOrderStatus,
} from "@/lib/store";
import { hyperswitchFetch } from "@/lib/hyperswitch";
import { checkRequestOrigin } from "@/lib/app-origin";
import { authenticateGuest, ownsOrder } from "@/lib/guest-session";
import { jsonNoStore, originRejected, sessionRequired, toOrderView } from "@/lib/order-access";
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

// Creates an order: atomically reserves inventory with a 10-minute hold
// AND persists the order, then creates a matching Hyperswitch payment.
// The charged amount is always computed here — tier price × quantity,
// plus a flat SERVICE_FEE_RATE service fee on that subtotal — the client
// only ever sends eventId, tierName, and quantity, never an amount.
//
// Phase 1B.4: the request must come from the trusted origin and must
// already carry a valid guest session (POST /api/guest-session). The order
// is bound to that guest inside the atomic reservation. This route never
// issues a session cookie itself, so a lost response cannot lose ownership.
export async function POST(request: Request) {
  const origin = checkRequestOrigin(request);
  if (!origin.ok) return originRejected(origin);
  const guest = await authenticateGuest(request);
  if (!guest) return sessionRequired();

  const body = await request.json().catch(() => null);
  const eventId = body?.eventId;
  const tierName = body?.tierName;
  const quantity = Number(body?.quantity);

  const event = getEvent(eventId);
  if (!event) {
    return jsonNoStore({ error: "Unknown event" }, 400);
  }

  const tier = event.tiers.find((t) => t.name === tierName);
  if (!tier) {
    return jsonNoStore({ error: "Unknown ticket tier" }, 400);
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ORDER) {
    return jsonNoStore({ error: `Quantity must be between 1 and ${MAX_QUANTITY_PER_ORDER}` }, 400);
  }

  // Friendly pre-check for a nice error message in the common case — the
  // atomic reserve below is what actually prevents overselling under
  // real concurrency; this just avoids a wasted Hyperswitch call when
  // it's obviously sold out. If inventory state can't be established
  // safely (e.g. a lost counter), refuse rather than guess.
  let remaining: number;
  try {
    remaining = await getRemainingInventory(event.id, tier.name, tier.totalInventory);
  } catch (err) {
    if (err instanceof InventoryStateError) {
      return jsonNoStore({ error: "Inventory temporarily unavailable" }, 503);
    }
    throw err;
  }
  if (quantity > remaining) {
    return jsonNoStore({ error: `Only ${remaining} ${tier.name} ticket(s) left` }, 400);
  }

  const subtotalCents = tier.priceCents * quantity;
  const feeCents = Math.round(subtotalCents * SERVICE_FEE_RATE);
  const amountCents = subtotalCents + feeCents;

  const order: Order = {
    id: randomUUID(),
    eventId: event.id,
    tierName: tier.name,
    quantity,
    unitPriceCents: tier.priceCents,
    feeCents,
    amountCents,
    currency: "USD",
    status: "pending",
    holdExpiresAt: Date.now() + HOLD_DURATION_MS,
    createdAt: Date.now(),
    ownerHash: guest.ownerHash,
  };

  // Atomic reserve + persist: either the seat is reserved AND the order
  // and its hold entry are stored, or nothing is. This closes the old
  // gap where a crash (or lost response) between the inventory decrement
  // and the order write would strand a seat with no recoverable order to
  // reap. The order is persisted here, before the provider call, because
  // its id has to exist to embed in Hyperswitch's metadata.orderId.
  // order.id is a fresh UUID, so "exists"/"conflict" are not expected on
  // this path; they're handled defensively. "lost" means the counter for
  // an initialized tier is missing — refuse rather than reset to full.
  const reservation = await reserveAndCreateOrder(order, tier.totalInventory);
  if (reservation === "sold_out") {
    // Lost a race with another buyer between the pre-check above and
    // here — report the current count (guarding the re-read too).
    let nowRemaining = 0;
    try {
      nowRemaining = await getRemainingInventory(event.id, tier.name, tier.totalInventory);
    } catch (err) {
      if (!(err instanceof InventoryStateError)) throw err;
    }
    return jsonNoStore({ error: `Only ${nowRemaining} ${tier.name} ticket(s) left` }, 400);
  }
  if (reservation === "lost") {
    return jsonNoStore({ error: "Inventory temporarily unavailable" }, 503);
  }
  if (reservation !== "created") {
    // exists / conflict / error
    return jsonNoStore({ error: "Could not create order" }, 500);
  }

  // Fire-and-forget-ish: counts toward the event page's "N reserved
  // recently" demand signal. Not awaited-for-correctness the way the
  // reservation is — worst case it fails silently and the badge just
  // under-counts; it never blocks or fails the purchase.
  await recordDemandSignal(event.id).catch(() => {});

  // Record that we are about to create a provider payment for this order,
  // BEFORE the call; cleared once the payment id is attached. Diagnostic
  // only: if attachment never completes, expiry notes the marker in the
  // reconciliation reason. Expiry never treats its ABSENCE as proof that no
  // payment exists — a payment-less expired order is always retained.
  await markPaymentAttempt(order.id);

  const response = await hyperswitchFetch("/payments", {
    method: "POST",
    body: JSON.stringify({
      amount: amountCents,
      currency: "USD",
      confirm: false,
      metadata: {
        orderId: order.id,
        eventId: event.id,
        tierName: tier.name,
        quantity: String(quantity),
        unitPrice: String(tier.priceCents),
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    // Atomic pending -> failed transition releases the reservation and
    // removes the hold (see lib/store.ts). Safe no-op if something else
    // already resolved the order in the meantime.
    // The provider's error body is logged in outline only and never
    // returned to the browser.
    await updateOrderStatus(order.id, "failed");
    console.warn(`[orders] payment create failed for order ${order.id}: HTTP ${response.status}`);
    return jsonNoStore({ error: "Could not set up payment" }, 502);
  }

  // Attach ONLY the payment id to the current stored order — never a
  // whole-object rewrite. The old rewrite re-persisted the in-memory
  // pending snapshot, which could reset a status a webhook or the
  // payment-status poll had already advanced in the sub-second window
  // between the create above and here, resurrecting a resolved hold.
  const attached = await attachPaymentId(order.id, data.payment_id);
  if (attached === "ok" || attached === "noop") {
    // The payment id is attached, so the order is no longer in the
    // orphan-risk window — drop the attempt marker. (Best-effort: if this
    // fails, the marker simply expires via its TTL.)
    await clearPaymentAttempt(order.id).catch(() => {});
  } else {
    // conflict/not_found/error: the order was resolved or removed out
    // from under us in that window. The payment exists and carries
    // metadata.orderId, so the webhook / payment-status route will
    // reconcile by order id; log and return the payment either way. The
    // attempt marker is deliberately LEFT set here — a payment was created
    // but not attached, so expiry must treat this order as a possible
    // orphan rather than release it.
    console.warn(
      `[orders] payment attach '${attached}' for order ${order.id} (payment ${data.payment_id})`
    );
  }

  // The widget needs the payment's client secret; the provider payment id is
  // deliberately not returned — the browser navigates by the order id.
  return jsonNoStore({
    clientSecret: data.client_secret,
    orderId: order.id,
    holdExpiresAt: order.holdExpiresAt,
    feeCents: order.feeCents,
    amountCents: order.amountCents,
  });
}
