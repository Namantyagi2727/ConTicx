import { NextResponse } from "next/server";
import { errorKind, runLogged, type RequestLog } from "@/lib/log";
import { bookingEnabled, browseOnlyResponse } from "@/lib/app-mode";
import {
  isWebhookEventProcessed,
  markWebhookEventProcessed,
  reconcilePaymentById,
} from "@/lib/store";
import {
  isValidPaymentId,
  readBoundedBody,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "@/lib/webhook-security";

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
// delivery, then reconciles against the authoritative current payment state
// using the shared policy (lib/store reconcilePaymentById -> retrieve +
// bind + decide + atomic transition), identical to the payment-status read
// and lazy expiry. The only fields read from the body are event_id (dedup),
// event_type (classification), and content.object.payment_id.
//
// Never cached, always re-run per request — this is an inbound webhook.
export const dynamic = "force-dynamic";

// Upper bound on the webhook request body. A Hyperswitch payment webhook is
// a few KB; 64 KiB is comfortable headroom while still bounding a hostile
// or buggy sender.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  return runLogged("webhook.receive", request, (log) => handle(request, log));
}

async function handle(request: Request, log: RequestLog): Promise<Response> {
  if (!bookingEnabled()) return browseOnlyResponse();
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
      log.set({ reason: "webhook_secret_not_configured" });
      return NextResponse.json(
        { error: "Webhook verification not configured" },
        { status: 503 }
      );
    }
    // missing / malformed / mismatch — never log the signature or the body.
    log.set({ reason: `signature_${verified.reason}` });
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
    log.set({ webhookEventId: eventId, reason: "unsupported_event" });
    return NextResponse.json(
      { received: true, handled: false, reason: "unsupported_event" },
      { status: 200 }
    );
  }

  const paymentId = body.content?.object?.payment_id;
  if (!isValidPaymentId(paymentId)) {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  log.set({ webhookEventId: eventId });

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

    // (6) Reconcile against authoritative provider state (shared policy).
    const outcome = await reconcilePaymentById(paymentId);

    switch (outcome.result) {
      case "unknown_payment":
        // The provider does not know this payment — a permanent rejection.
        log.set({ reason: "unknown_payment" });
        return NextResponse.json({ error: "Unknown payment" }, { status: 422 });

      case "mismatch":
        // Binding failed (id / association / amount / currency / merchant).
        log.set({ reason: `binding_${outcome.reason}` });
        return NextResponse.json({ error: "Binding check failed" }, { status: 422 });

      case "not_ready":
        // Early webhook: the order's payment id is not attached yet. Retry.
        return NextResponse.json({ error: "Not ready" }, { status: 503 });

      case "transient":
        // Provider or transition transient failure. Retryable; no marker.
        return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });

      case "not_final":
        // Non-terminal provider status: no guessed terminal outcome.
        // Retryable; no marker, so a later authoritative delivery resolves it.
        return NextResponse.json(
          { received: true, handled: false, reason: "not_final" },
          { status: 503 }
        );

      case "retained":
        // Failed payment: retained (may be retried), flagged for
        // reconciliation. A processed outcome — mark it so the provider
        // stops redelivering this event.
        await markWebhookEventProcessed(eventId);
        return NextResponse.json(
          { received: true, handled: true, reason: "failed_retained" },
          { status: 200 }
        );

      case "conflict":
        // The order is already in a different terminal state; the conflict
        // was recorded, not overwritten. Acknowledge so the provider stops
        // retrying something we deliberately declined to act on.
        log.set({ reason: `conflict_over_${outcome.current}` });
        await markWebhookEventProcessed(eventId);
        return NextResponse.json(
          { received: true, handled: false, reason: "conflict" },
          { status: 200 }
        );

      case "paid":
        await markWebhookEventProcessed(eventId);
        return NextResponse.json(
          { received: true, handled: true, status: "succeeded" },
          { status: 200 }
        );

      case "released":
        await markWebhookEventProcessed(eventId);
        return NextResponse.json(
          { received: true, handled: true, reason: "released" },
          { status: 200 }
        );
    }
  } catch (err) {
    // Redis or other infrastructure failure: retryable, no marker.
    log.set({ reason: "processing_error", errorKind: errorKind(err) });
    return NextResponse.json({ error: "Processing failed" }, { status: 503 });
  }
}
