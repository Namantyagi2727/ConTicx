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
// Never cached, and always re-run per request — this is an inbound
// webhook, not a page.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Read the body as raw text, not request.json(), because signature
  // verification has to run over the exact bytes Hyperswitch sent.
  // Parsing to an object and re-serializing with JSON.stringify can
  // reorder keys or change whitespace, which would silently break an
  // HMAC comparison computed against the original bytes.
  const rawBody = await request.text();

  // Production signature verification would go here, before rawBody
  // is trusted at all:
  //
  //   import { createHmac, timingSafeEqual } from "node:crypto";
  //
  //   const signature = request.headers.get("x-webhook-signature-512");
  //   const expected = createHmac("sha512", process.env.HYPERSWITCH_WEBHOOK_SECRET!)
  //     .update(rawBody)
  //     .digest("hex");
  //   const valid =
  //     signature?.length === expected.length &&
  //     timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  //   if (!valid) {
  //     return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  //   }
  //
  // HYPERSWITCH_WEBHOOK_SECRET would be the business profile's
  // payment_response_hash_key from the Hyperswitch dashboard.
  // timingSafeEqual (not ===) matters: a plain string comparison
  // short-circuits on the first differing byte, which leaks how many
  // leading bytes were correct through response timing.
  //
  // Skipped here to keep the sandbox prototype simple — without it,
  // anyone who finds this URL can forge order status updates.

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed webhook payload" }, { status: 400 });
  }

  const payload = body as {
    event_type?: string;
    content?: { object?: { payment_id?: string; metadata?: { orderId?: string } } };
  };

  const eventType = payload.event_type;
  const payment = payload.content?.object;

  if (!eventType || !payment?.payment_id) {
    return NextResponse.json({ error: "Malformed webhook payload" }, { status: 400 });
  }

  const orderId = payment.metadata?.orderId;

  console.log(
    `[hyperswitch webhook] ${eventType} for payment ${payment.payment_id} (order ${orderId ?? "unknown"})`
  );

  // Order status transitions are driven from here and from the
  // payment-status route, never from the browser redirect alone — the
  // browser only ever tells us the shopper's screen changed, not what
  // actually happened at Hyperswitch.
  //
  // updateOrderStatus only acts on an order that's still "pending"
  // (see lib/store.ts), so redelivery of this same event — Hyperswitch
  // retries webhooks, and this can also race with the payment-status
  // route reconciling the same payment — is a safe no-op the second
  // time, not a double release of inventory.
  if (orderId) {
    if (eventType === "payment_succeeded") {
      await updateOrderStatus(orderId, "succeeded");
    } else if (
      eventType === "payment_failed" ||
      eventType === "payment_cancelled" ||
      eventType === "payment_expired"
    ) {
      await updateOrderStatus(orderId, "failed");
    }
  }

  return NextResponse.json({ received: true });
}
