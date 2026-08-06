import { NextResponse } from "next/server";
import { getOrder, markOrderRefunded } from "@/lib/store";
import { hyperswitchFetch } from "@/lib/hyperswitch";

// Full refunds only, no partial amounts and no refund-window logic
// (e.g. "only refundable up to 24h before the event"). Those are
// policy decisions a real app would layer on top of this — checked
// before ever calling Hyperswitch, using the same order data already
// available here — not something that changes how the refund call
// itself works.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const order = await getOrder(id);

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  if (order.status === "refunded") {
    // Idempotent: a duplicate/retried request against an order we've
    // already refunded is a success, not an error.
    return NextResponse.json({ refunded: true });
  }

  if (order.status !== "succeeded" || !order.paymentId) {
    return NextResponse.json(
      { error: "Only a successfully paid order can be refunded" },
      { status: 400 }
    );
  }

  const response = await hyperswitchFetch("/refunds", {
    method: "POST",
    body: JSON.stringify({
      payment_id: order.paymentId,
      amount: order.amountCents, // explicit full amount, see comment above
    }),
  });

  const data = await response.json();

  // Hyperswitch's refund status can be "succeeded", "pending",
  // "failed", or "review" even on a 200 response — a connector can
  // accept a refund request without settling it immediately. Only a
  // clean "succeeded" is treated as done here; anything else is
  // surfaced as an error rather than tracked further, since resolving
  // an async refund would need a webhook handler this prototype
  // doesn't have (the flow above assumes FauxPay/PayPal sandbox both
  // settle refunds synchronously, which is what we've verified live).
  if (!response.ok || data.status !== "succeeded") {
    return NextResponse.json({ error: data }, { status: response.ok ? 502 : response.status });
  }

  await markOrderRefunded(order.id);

  return NextResponse.json({ refunded: true, refundId: data.refund_id });
}
