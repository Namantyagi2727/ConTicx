import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getEvent } from "@/lib/events";
import { HOLD_DURATION_MS, MAX_QUANTITY_PER_ORDER } from "@/lib/constants";
import {
  createOrder,
  getRemainingInventory,
  reserveInventory,
  updateOrderStatus,
} from "@/lib/store";
import { hyperswitchFetch } from "@/lib/hyperswitch";
import type { Order } from "@/lib/types";

// Creates an order: reserves inventory with a 10-minute hold, then
// creates a matching Hyperswitch payment. The amount is always
// computed here from the tier's price × quantity — the client only
// ever sends eventId, tierName, and quantity, never an amount.
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

  // Friendly pre-check for a nice error message in the common case —
  // the atomic reserve below is what actually prevents overselling
  // under real concurrency; this just avoids a wasted Hyperswitch call
  // when it's obviously sold out.
  const remaining = await getRemainingInventory(event.id, tier.name, tier.totalInventory);
  if (quantity > remaining) {
    return NextResponse.json(
      { error: `Only ${remaining} ${tier.name} ticket(s) left` },
      { status: 400 }
    );
  }

  const reserved = await reserveInventory(event.id, tier.name, quantity, tier.totalInventory);
  if (!reserved) {
    // Lost a race with another buyer between the check above and here.
    const nowRemaining = await getRemainingInventory(event.id, tier.name, tier.totalInventory);
    return NextResponse.json(
      { error: `Only ${nowRemaining} ${tier.name} ticket(s) left` },
      { status: 400 }
    );
  }

  const amountCents = tier.priceCents * quantity;

  const order: Order = {
    id: randomUUID(),
    eventId: event.id,
    tierName: tier.name,
    quantity,
    unitPriceCents: tier.priceCents,
    amountCents,
    currency: "USD",
    status: "pending",
    holdExpiresAt: Date.now() + HOLD_DURATION_MS,
    createdAt: Date.now(),
  };

  await createOrder(order);

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
    // updateOrderStatus releases the reservation as a side effect of
    // moving a pending order to "failed" — see lib/store.ts.
    await updateOrderStatus(order.id, "failed");
    return NextResponse.json({ error: data }, { status: response.status });
  }

  // The order was already persisted as "pending" above (before we knew
  // paymentId, since order.id needs to exist to embed in Hyperswitch's
  // metadata). Persist again now that paymentId is known — Redis has
  // no shared object reference to mutate in place the way the old
  // in-memory Map did.
  order.paymentId = data.payment_id;
  await createOrder(order);

  return NextResponse.json({
    clientSecret: data.client_secret,
    paymentId: data.payment_id,
    orderId: order.id,
    holdExpiresAt: order.holdExpiresAt,
    amountCents: order.amountCents,
  });
}
