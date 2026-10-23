import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getEvent } from "@/lib/events";
import { HOLD_DURATION_MS, MAX_QUANTITY_PER_ORDER, SERVICE_FEE_RATE } from "@/lib/constants";
import {
  attachPaymentId,
  clearPaymentAttempt,
  getRemainingInventory,
  InventoryStateError,
  markPaymentAttempt,
  recordDemandSignal,
  reserveAndCreateOrder,
  updateOrderStatus,
} from "@/lib/store";
import { hyperswitchFetch } from "@/lib/hyperswitch";
import type { Order } from "@/lib/types";

// Creates an order: atomically reserves inventory with a 10-minute hold
// AND persists the order, then creates a matching Hyperswitch payment.
// The charged amount is always computed here — tier price × quantity,
// plus a flat SERVICE_FEE_RATE service fee on that subtotal — the client
// only ever sends eventId, tierName, and quantity, never an amount.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const eventId = body?.eventId;
  const tierName = body?.tierName;
  const quantity = Number(body?.quantity);

  const event = getEvent(eventId);
  if (!event) {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 });
  }

  const tier = event.tiers.find((t) => t.name === tierName);
  if (!tier) {
    return NextResponse.json({ error: "Unknown ticket tier" }, { status: 400 });
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ORDER) {
    return NextResponse.json(
      { error: `Quantity must be between 1 and ${MAX_QUANTITY_PER_ORDER}` },
      { status: 400 }
    );
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
      return NextResponse.json({ error: "Inventory temporarily unavailable" }, { status: 503 });
    }
    throw err;
  }
  if (quantity > remaining) {
    return NextResponse.json(
      { error: `Only ${remaining} ${tier.name} ticket(s) left` },
      { status: 400 }
    );
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
    return NextResponse.json(
      { error: `Only ${nowRemaining} ${tier.name} ticket(s) left` },
      { status: 400 }
    );
  }
  if (reservation === "lost") {
    return NextResponse.json({ error: "Inventory temporarily unavailable" }, { status: 503 });
  }
  if (reservation !== "created") {
    // exists / conflict / error
    return NextResponse.json({ error: "Could not create order" }, { status: 500 });
  }

  // Fire-and-forget-ish: counts toward the event page's "N reserved
  // recently" demand signal. Not awaited-for-correctness the way the
  // reservation is — worst case it fails silently and the badge just
  // under-counts; it never blocks or fails the purchase.
  await recordDemandSignal(event.id).catch(() => {});

  // Record that we are about to create a provider payment for this order,
  // BEFORE the call. If creation succeeds but attachment never completes,
  // this durable marker lets lazy expiry tell "a payment may exist but was
  // never attached" (retain + flag) from "no provider call was ever made"
  // (safe to release). Cleared once the payment id is attached.
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
    await updateOrderStatus(order.id, "failed");
    return NextResponse.json({ error: data }, { status: response.status });
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

  return NextResponse.json({
    clientSecret: data.client_secret,
    paymentId: data.payment_id,
    orderId: order.id,
    holdExpiresAt: order.holdExpiresAt,
    feeCents: order.feeCents,
    amountCents: order.amountCents,
  });
}
