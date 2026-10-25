import { retrievePayment } from "@/lib/hyperswitch";
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
  const { id } = await params;
  const lookup = await loadOwnedOrder(request, id);
  if (lookup.kind === "no_session") return sessionRequired();
  if (lookup.kind === "not_found") return orderNotFound();

  let order = lookup.order;
  if (order.paymentId && !isValidPaymentId(order.paymentId)) {
    // A stored id that is not a well-formed provider id is never put into a
    // provider URL. Nothing to refresh; report the order as stored.
    console.warn(`[orders] status refresh skipped for order ${order.id}: malformed payment id`);
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
      console.error(
        `[orders] status refresh failed for order ${order.id}:`,
        err instanceof Error ? err.message : "unknown"
      );
    }
  }

  return jsonNoStore(toOrderView(order));
}
