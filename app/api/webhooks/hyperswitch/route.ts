import { NextResponse } from "next/server";
import {
  isWebhookEventProcessed,
  markWebhookEventProcessed,
  peekOrder,
  transitionOrder,
} from "@/lib/store";
import { retrievePayment, type ProviderPayment } from "@/lib/hyperswitch";
import {
  isValidPaymentId,
  readBoundedBody,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "@/lib/webhook-security";
import type { OrderStatus } from "@/lib/types";

// Hyperswitch's outgoing webhook body (OutgoingWebhook / EventType in the
// hyperswitch source):
//   {
//     merchant_id, event_id,
//     event_type: "payment_succeeded" | "payment_failed" | ... (snake_case),
//     content: { type: "payment_details", object: <PaymentsResponse> },
//     timestamp
//   }
// We do NOT trust content.object for the decision. The body is signed (and
// therefore authentic), but it can be stale or delivered out of order, so
// the handler treats the webhook as a NOTIFICATION: it authenticates the
// delivery, then retrieves the authoritative current payment state from the
// provider and acts on that. The only fields read from the body are
// event_id (dedup), event_type (classification), and content.object
// .payment_id (which payment to retrieve).
//
// Never cached, always re-run per request — this is an inbound webhook.
export const dynamic = "force-dynamic";

// Upper bound on the webhook request body. A Hyperswitch payment webhook is
// a few KB; 64 KiB is comfortable headroom while still bounding a hostile
// or buggy sender.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  // (1) Bounded raw-body read. Signature verification needs the exact
  // bytes, so we read once here and reuse the buffer for both the HMAC and
  // the JSON parse — never request.json(), which would re-serialize and
  // could reorder keys / change whitespace, breaking the digest.
  const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // (2) Fail-closed authentication, BEFORE any parse / Redis / provider
  // work. An invalid or absent signature causes zero side effects.
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const verified = verifyWebhookSignature(
    rawBody,
    signature,
    process.env.HYPERSWITCH_WEBHOOK_SECRET
  );
  if (!verified.ok) {
    if (verified.reason === "no_secret") {
      // Server misconfiguration: we cannot verify, so we refuse to process
      // an unverifiable body. Retryable once the secret is configured.
      // Never log the (absent) secret.
      console.error(
        "[hyperswitch webhook] HYPERSWITCH_WEBHOOK_SECRET is not configured; refusing delivery"
      );
      return NextResponse.json(
        { error: "Webhook verification not configured" },
        { status: 503 }
      );
    }
    // missing / malformed / mismatch — never log the raw signature.
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // (3) Authenticated: now it is safe to parse the body.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  const body = parsed as {
    event_id?: unknown;
    event_type?: unknown;
    content?: { object?: { payment_id?: unknown } };
  };

  const eventId = body.event_id;
  const eventType = body.event_type;
  if (
    typeof eventId !== "string" ||
    eventId === "" ||
    typeof eventType !== "string" ||
    eventType === ""
  ) {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  // (4) Classify. We only act on payment notifications. Everything else —
  // refunds (explicitly out of scope this phase), disputes, unknown types —
  // is acknowledged as intentionally unsupported so the provider stops
  // retrying it. No mutation, no dedup marker.
  if (!eventType.startsWith("payment")) {
    console.log(
      `[hyperswitch webhook] acknowledged unsupported event_type '${eventType}' (event ${eventId})`
    );
    return NextResponse.json(
      { received: true, handled: false, reason: "unsupported_event" },
      { status: 200 }
    );
  }

  const paymentId = body.content?.object?.payment_id;
  if (!isValidPaymentId(paymentId)) {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  // Everything below can touch Redis or the provider. Collapse any
  // unexpected infrastructure error to a retryable 503 that leaves NO dedup
  // marker, so the delivery is redelivered rather than silently dropped.
  try {
    // (5) Dedup fast-path. A sequential redelivery of an already-processed
    // event skips the provider read entirely. Concurrent duplicates may
    // both miss this and both read the provider — the atomic transition,
    // not this check, is what prevents a duplicate business effect.
    if (await isWebhookEventProcessed(eventId)) {
      return NextResponse.json(
        { received: true, handled: true, reason: "duplicate" },
        { status: 200 }
      );
    }

    // (6) Retrieve the AUTHORITATIVE current payment state.
    const retrieved = await retrievePayment(paymentId);
    if (!retrieved.ok) {
      if (retrieved.category === "not_found") {
        // The provider does not know this payment — a permanent rejection,
        // not a transient condition. No mutation, no marker.
        console.warn(
          `[hyperswitch webhook] payment not found at provider (event ${eventId})`
        );
        return NextResponse.json({ error: "Unknown payment" }, { status: 422 });
      }
      // Transient (timeout / non-2xx / non-JSON / network). Retryable; no
      // marker, so the provider redelivers.
      return NextResponse.json({ error: "Provider unavailable" }, { status: 503 });
    }

    // (7) Bind the authoritative payment to our stored order. A mismatch is
    // a permanent rejection with NO mutation; a not-yet-ready local
    // association (early webhook) is transient and retryable.
    const bind = await bindPaymentToOrder(retrieved.payment, paymentId);
    if (bind.kind === "retry") {
      return NextResponse.json({ error: "Not ready" }, { status: 503 });
    }
    if (bind.kind === "reject") {
      console.warn(
        `[hyperswitch webhook] binding rejected (event ${eventId}): ${bind.message}`
      );
      return NextResponse.json({ error: "Binding check failed" }, { status: 422 });
    }

    // (8) Apply only the transition the authoritative provider status
    // justifies, using the Phase 1B.1 atomic compare-and-set.
    const decision = decideFromStatus(retrieved.payment.status);

    if (decision.action === "pending") {
      // Unknown / ambiguous / non-terminal for our purposes (processing,
      // requires_*, review, partially_*). We do NOT guess a terminal
      // outcome. Retryable; no marker, so a later authoritative delivery
      // resolves it.
      return NextResponse.json(
        { received: true, handled: false, reason: "not_final" },
        { status: 503 }
      );
    }

    if (decision.action === "retain") {
      // provider 'failed': do NOT release inventory — a failed payment may
      // still be retried by the shopper via a new intent. The hold stands
      // and is reaped on timeout if no success arrives. This is a processed
      // outcome (we decided, deliberately, to take no inventory action).
      await markWebhookEventProcessed(eventId);
      return NextResponse.json(
        { received: true, handled: true, reason: "failed_retained" },
        { status: 200 }
      );
    }

    // succeed | release: a single guarded pending -> terminal transition.
    const result = await transitionOrder(bind.orderId, "pending", decision.to, decision.release);

    if (result === "error" || result === "not_found") {
      // Data/infra error, or the order vanished mid-flight — retryable, no
      // marker.
      return NextResponse.json({ error: "Could not apply transition" }, { status: 503 });
    }

    if (result === "conflict") {
      // The order is already in a different terminal state (e.g. the hold
      // was reaped as expired, or a refund landed) and we must not
      // overwrite it. Report the unresolved conflict for later
      // reconciliation, acknowledge the delivery so the provider stops
      // retrying something we have deliberately declined to act on, and
      // mark it processed.
      console.warn(
        `[hyperswitch webhook] unresolved conflict: order not pending for provider status ` +
          `'${retrieved.payment.status}' (event ${eventId}) — left for reconciliation`
      );
      await markWebhookEventProcessed(eventId);
      return NextResponse.json(
        { received: true, handled: false, reason: "conflict" },
        { status: 200 }
      );
    }

    // applied | noop: the justified outcome is durably recorded. Mark the
    // event processed ONLY now (after the durable transition), so a crash
    // before this point redelivers and re-applies the idempotent
    // transition rather than skipping it.
    await markWebhookEventProcessed(eventId);
    return NextResponse.json(
      { received: true, handled: true, status: decision.to },
      { status: 200 }
    );
  } catch (err) {
    // Redis or other infrastructure failure: retryable, no marker.
    console.error(
      `[hyperswitch webhook] processing error (event ${eventId}):`,
      err instanceof Error ? err.message : "unknown"
    );
    return NextResponse.json({ error: "Processing failed" }, { status: 503 });
  }
}

type BindOutcome =
  | { kind: "ok"; orderId: string }
  | { kind: "retry"; message: string }
  | { kind: "reject"; message: string };

// Binds the authoritative provider payment to our stored order. The checks
// are deliberately strict and two-way: the provider's metadata points at an
// order, AND that stored order must point back at this very payment, with a
// matching amount and currency. Metadata alone never authorizes a change.
async function bindPaymentToOrder(
  pp: ProviderPayment,
  requestedPaymentId: string
): Promise<BindOutcome> {
  // (a) The provider returned the payment we asked about.
  if (pp.payment_id !== requestedPaymentId) {
    return { kind: "reject", message: "returned payment id mismatch" };
  }

  // (b) Merchant/profile identity, only where a reliable expectation is
  // configured. Unset -> skipped (documented); set -> must match the
  // authoritative provider value.
  const expectedMerchant = process.env.HYPERSWITCH_MERCHANT_ID;
  if (expectedMerchant && pp.merchant_id && pp.merchant_id !== expectedMerchant) {
    return { kind: "reject", message: "merchant mismatch" };
  }

  // (c) Order association from the AUTHORITATIVE payment metadata, then
  // confirmed against the stored order via a no-reap read.
  const orderId = pp.metadata?.orderId;
  if (typeof orderId !== "string" || orderId === "") {
    return { kind: "reject", message: "no order association" };
  }

  const order = await peekOrder(orderId);
  if (!order) {
    return { kind: "reject", message: "unknown order" };
  }

  if (!order.paymentId) {
    // Legitimate early webhook: the order exists but the payment id has not
    // been attached yet (the create -> attach window). Transient; retry.
    return { kind: "retry", message: "order association not ready" };
  }
  if (order.paymentId !== requestedPaymentId) {
    return { kind: "reject", message: "payment/order association mismatch" };
  }

  // (d) Authoritative amount and currency must match what we stored.
  if (order.amountCents !== pp.amount) {
    return { kind: "reject", message: "amount mismatch" };
  }
  if (order.currency !== pp.currency) {
    return { kind: "reject", message: "currency mismatch" };
  }

  return { kind: "ok", orderId };
}

type Decision =
  | { action: "succeed"; to: OrderStatus; release: boolean }
  | { action: "release"; to: OrderStatus; release: boolean }
  | { action: "retain" }
  | { action: "pending" };

// Maps the AUTHORITATIVE Hyperswitch payment status to the single order
// transition it justifies. The terminal classification follows
// Hyperswitch's own IntentStatus::is_in_terminal_state
// (crates/common_enums/src/enums.rs), which is terminal for: succeeded,
// failed, cancelled, cancelled_post_capture, partially_captured, expired.
//
// Policy (explicit and small):
//   succeeded            -> mark succeeded, keep the seat. The ONLY status
//                           treated as authoritative payment success.
//   cancelled | expired  -> release inventory. Terminal AND unpaid (the
//                           intent was voided / expired before capture), so
//                           the seat is genuinely free.
//   failed               -> RETAIN inventory. Terminal at the intent level,
//                           but the audit established a failed payment may
//                           still be retried by the shopper, so we do not
//                           release; the hold is reaped on timeout instead.
//   anything else        -> no terminal outcome. Covers processing,
//                           requires_*, review, conflicted, and the
//                           captured-funds cases (cancelled_post_capture,
//                           partially_*) that are out of scope for this
//                           full-amount flow. We never guess; retry.
function decideFromStatus(status: string): Decision {
  switch (status) {
    case "succeeded":
      return { action: "succeed", to: "succeeded", release: false };
    case "cancelled":
      return { action: "release", to: "failed", release: true };
    case "expired":
      return { action: "release", to: "expired", release: true };
    case "failed":
      return { action: "retain" };
    default:
      return { action: "pending" };
  }
}
