import { retrievePayment } from "@/lib/hyperswitch";
import { peekOrder, reconcileRetrievedPayment } from "@/lib/store";
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
// Ownership is verified FIRST. Only then, and only for a still-pending order
// that has an attached payment, is the provider read — using the payment id
// stored on the owned order, never one supplied by the client — and the
// result reconciled through the shared policy (same binding and outcomes as
// the webhook and expiry). The response is the order's allow-listed view
// after that refresh; provider bodies are never returned.
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
  if (order.status === "pending" && order.paymentId) {
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
