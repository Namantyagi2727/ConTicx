import { NextResponse } from "next/server";
import { updateOrderStatus } from "@/lib/store";

// Hyperswitch's outgoing webhook body (see OutgoingWebhook /
// OutgoingWebhookContent / EventType in the hyperswitch source):
//   {
//     merchant_id, event_id,
//     event_type: "payment_succeeded" | "payment_failed" | ... (snake_case),
//     content: { type: "payment_details", object: <PaymentsResponse> },
//     timestamp
//   }
// content.object is the same shape returned by GET /payments/{id}, so
// it carries our metadata.orderId straight through — no extra API
// call needed to know which order this event is about.
//
// Signature verification: in production this route would hash the raw
// request body with HMAC-SHA512 using the merchant's
// payment_response_hash_key (set on the Hyperswitch dashboard's
// business profile) and compare it, constant-time, against the
// `x-webhook-signature-512` request header before trusting the
// payload — otherwise anyone who finds this URL can forge order
// status updates. Skipped here to keep the sandbox prototype simple.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  const eventType: string | undefined = body?.event_type;
  const payment = body?.content?.object;

  if (!eventType || !payment?.payment_id) {
    return NextResponse.json({ error: "Malformed webhook payload" }, { status: 400 });
  }

  const orderId: string | undefined = payment.metadata?.orderId;

  console.log(
    `[hyperswitch webhook] ${eventType} for payment ${payment.payment_id} (order ${orderId ?? "unknown"})`
  );

  // Order status transitions are driven from here and from the
  // payment-status route, never from the browser redirect alone — the
  // browser only ever tells us the shopper's screen changed, not what
  // actually happened at Hyperswitch.
  if (orderId) {
    if (eventType === "payment_succeeded") {
      updateOrderStatus(orderId, "succeeded");
    } else if (
      eventType === "payment_failed" ||
      eventType === "payment_cancelled" ||
      eventType === "payment_expired"
    ) {
      updateOrderStatus(orderId, "failed");
    }
  }

  return NextResponse.json({ received: true });
}
