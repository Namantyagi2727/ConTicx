import { retrievePayment } from "@/lib/hyperswitch";
import { errorKind, runLogged, type RequestLog } from "@/lib/log";
import { bookingEnabled, browseOnlyResponse } from "@/lib/app-mode";
import { peekOrder, reconcileRetrievedPayment } from "@/lib/store";
import { isValidPaymentId } from "@/lib/webhook-security";
import {
  jsonNoStore,
  loadOwnedOrder,
  orderNotFound,
  sessionRequired,
  toOrderView,
} from "@/lib/order-access";

// Order-scoped status refresh for the confirmation page. Replaces the old
// public GET /api/payments/[id], which let anyone who knew a provider payment
// id read it and trigger reconciliation.
//
// Ownership is verified FIRST. Only then, for an owned order with an attached
// payment, is the provider read — using the payment id stored on the owned
// order (shape-checked with the same rule as webhook payment ids), never one
// supplied by the client — and the result reconciled through the shared
// policy, exactly as the old payment-status route did for every lookup:
// a pending order may resolve, and an already-terminal order is left as it
// is while a conflicting authoritative outcome is recorded for
// reconciliation. Authorization changed WHO can trigger this, not what it
// does. The response is the order's allow-listed view after the refresh;
// provider bodies are never returned.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return runLogged("order.status", request, (log) => handle(request, params, log));
}

async function handle(
  request: Request,
  params: Promise<{ id: string }>,
  log: RequestLog
): Promise<Response> {
  if (!bookingEnabled()) return browseOnlyResponse();
  const { id } = await params;
  const lookup = await loadOwnedOrder(request, id);
  if (lookup.kind === "no_session") return sessionRequired();
  if (lookup.kind === "not_found") return orderNotFound();
  // Only an order this caller owns is named in the log.
  log.set({ orderId: lookup.order.id });

  let order = lookup.order;
  if (order.paymentId && !isValidPaymentId(order.paymentId)) {
    // A stored id that is not a well-formed provider id is never put into a
    // provider URL. Nothing to refresh; report the order as stored.
    log.set({ reason: "malformed_payment_id" });
  } else if (order.paymentId) {
    const paymentId = order.paymentId;
    // Best effort: a provider or Redis hiccup leaves the stored status as it
    // is, and the page simply polls again.
    try {
      const retrieved = await retrievePayment(paymentId);
      if (retrieved.ok) {
        await reconcileRetrievedPayment(retrieved.payment, paymentId);
        order = (await peekOrder(order.id)) ?? order;
      }
    } catch (err) {
      log.set({ reason: "refresh_failed", errorKind: errorKind(err) });
    }
  }

  log.set({ outcome: order.status });
  return jsonNoStore(toOrderView(order));
}
