import { NextResponse } from "next/server";
import { hyperswitchFetch } from "@/lib/hyperswitch";
import { updateOrderStatus } from "@/lib/store";

// Looks up the current status of a payment straight from Hyperswitch.
// The confirmation page calls this instead of trusting the client SDK —
// Hyperswitch's own backend is the source of truth for payment status.
//
// Also opportunistically reconciles our local order record from the
// payment's metadata.orderId. There's no webhook in this prototype, so
// this is the one place order status catches up with reality — without
// it, a succeeded order's hold would eventually get lazily reaped as
// "expired" and its inventory wrongly released back into the pool.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const response = await hyperswitchFetch(`/payments/${id}`);
  const data = await response.json();

  if (!response.ok) {
    return NextResponse.json({ error: data }, { status: response.status });
  }

  const orderId = data.metadata?.orderId;
  if (orderId) {
    if (data.status === "succeeded") {
      updateOrderStatus(orderId, "succeeded");
    } else if (data.status === "failed" || data.status === "cancelled") {
      updateOrderStatus(orderId, "failed");
    }
  }

  return NextResponse.json({
    paymentId: data.payment_id,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    metadata: data.metadata ?? null,
  });
}
