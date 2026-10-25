// Guest-facing order access (Phase 1B.4). Every route that reads one order
// goes through loadOwnedOrder: authenticate the guest, validate the id, read
// the stored order WITHOUT side effects (no reap, no provider call), and
// check ownership — before anything sensitive happens. A missing order, an
// order owned by someone else, a legacy order with no owner, and a malformed
// id all produce the same generic 404, so a response never reveals whether
// an order id exists.

import { NextResponse } from "next/server";
import { authenticateGuest, ownsOrder, type GuestIdentity } from "./guest-session";
import type { OriginCheck } from "./app-origin";
import { peekOrder } from "./store";
import type { Order, OrderView } from "./types";

// Order ids are crypto.randomUUID() values. Anything else is rejected before
// it is used in a Redis key.
const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidOrderId(id: unknown): id is string {
  return typeof id === "string" && ORDER_ID_RE.test(id);
}

// Guest-specific responses must never be stored by a browser or shared cache.
export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function jsonNoStore(body: unknown, status = 200, extra?: HeadersInit): NextResponse {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { status, headers });
}

export function orderNotFound(): NextResponse {
  return jsonNoStore({ error: "Order not found" }, 404);
}

// No valid guest session at all. Independent of any order id, so it reveals
// nothing about one; the UI uses it to explain the same-browser rule.
export function sessionRequired(): NextResponse {
  return jsonNoStore({ error: "Guest session required" }, 401);
}

export function originRejected(check: Exclude<OriginCheck, { ok: true }>): NextResponse {
  if (check.reason === "not_configured") {
    console.error("[origin] APP_ORIGIN is not configured; refusing browser mutation");
    return jsonNoStore({ error: "Service not configured" }, 503);
  }
  return jsonNoStore({ error: "Forbidden" }, 403);
}

// The allow-listed fields a guest sees. Never ownerHash, never paymentId.
export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    eventId: order.eventId,
    tierName: order.tierName,
    quantity: order.quantity,
    unitPriceCents: order.unitPriceCents,
    feeCents: order.feeCents,
    amountCents: order.amountCents,
    currency: order.currency,
    status: order.status,
    holdExpiresAt: order.holdExpiresAt,
    createdAt: order.createdAt,
  };
}

export type OwnedOrderLookup =
  | { kind: "no_session" }
  | { kind: "not_found" }
  | { kind: "ok"; order: Order; guest: GuestIdentity };

export async function loadOwnedOrder(request: Request, id: unknown): Promise<OwnedOrderLookup> {
  const guest = await authenticateGuest(request);
  if (!guest) return { kind: "no_session" };
  if (!isValidOrderId(id)) return { kind: "not_found" };
  const order = await peekOrder(id);
  if (!order || !ownsOrder(order, guest.ownerHash)) return { kind: "not_found" };
  return { kind: "ok", order, guest };
}
