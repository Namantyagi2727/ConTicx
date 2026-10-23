import { NextResponse } from "next/server";
import { retrievePayment } from "@/lib/hyperswitch";
import { reconcileRetrievedPayment } from "@/lib/store";

// Looks up the current status of a payment straight from Hyperswitch. The
// confirmation page calls this instead of trusting the client SDK —
// Hyperswitch's own backend is the source of truth for payment status.
//
// It also reconciles our order from the payment's AUTHORITATIVE state, as a
// safety net alongside the webhook, using the SAME binding and outcome
// policy (lib/store reconcileRetrievedPayment): metadata alone does not
// authorize a change; a retryable failed payment is retained, not released
// (so this route cannot free a seat that expiry is deliberately holding);
// and a success conflicting with an already-resolved order is recorded, not
// overwritten into a valid ticket.
//
// NOTE: this route does not yet authorize the CALLER — anyone who knows a
// payment id can read it and trigger reconciliation. That unauthorized-
// lookup concern is the separate, deferred guest-authorization phase; the
// stronger binding here does not address it.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const retrieved = await retrievePayment(id);
  if (!retrieved.ok) {
    // Never surface the raw provider body.
    return NextResponse.json(
      { error: "Payment unavailable" },
      { status: retrieved.category === "not_found" ? 404 : 502 }
    );
  }
  const payment = retrieved.payment;

  // Best-effort reconciliation: a Redis hiccup here must not prevent the
  // confirmation page from seeing the authoritative payment status.
  try {
    await reconcileRetrievedPayment(payment, id);
  } catch (err) {
    console.error(
      `[payments] reconcile error for payment (${id}):`,
      err instanceof Error ? err.message : "unknown"
    );
  }

  return NextResponse.json({
    paymentId: payment.payment_id,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    metadata: payment.metadata ?? null,
  });
}
