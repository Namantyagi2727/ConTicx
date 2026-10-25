// Payment creation for a booked order (Phase 1B.5).
//
// Every order is reserved with a provider payment identity already chosen
// and stored (order.paymentRequestId), so creating its payment — the first
// time, after a crash, after a lost response, or from a concurrent retry —
// always targets the SAME provider payment_id. That, and not any lock, is
// what makes a retry safe: per the provider contract (lib/hyperswitch.ts
// createPayment) a second create under an existing id cannot make another
// payment; it is rejected as a duplicate, and the existing payment is then
// retrieved by id.
//
// ensureOrderPayment never invents a new identity, never releases inventory
// on an uncertain outcome, and never attaches a provider payment that does
// not bind to the order (id, order id, amount, currency). Outcomes:
//   ready       payment confirmed and attached; client secret for checkout.
//   processing  another request holds the creation lease, the provider is
//               unavailable, or the outcome is uncertain (flagged for
//               reconciliation). The caller retries the same attempt later.
//   closed      the order is no longer bookable: terminal, or its hold has
//               lapsed. Never turned into a new booking.
//   failed      the provider definitively rejected creation; the order was
//               failed and its seats released (only if no payment had been
//               attached in the meantime).

import { BOOKING_PAYMENT_LEASE_MS } from "./constants";
import { createPayment, retrievePayment, type ProviderPayment } from "./hyperswitch";
import {
  attachPaymentId,
  claimPaymentLease,
  clearPaymentAttempt,
  flagForReconciliation,
  markPaymentAttempt,
  peekOrder,
  releasePaymentLease,
  transitionOrder,
} from "./store";
import { isValidPaymentId } from "./webhook-security";
import type { Order } from "./types";

export type EnsurePaymentResult =
  | { kind: "ready"; order: Order; clientSecret: string }
  | { kind: "processing"; order: Order; reason: string }
  | { kind: "closed"; order: Order }
  | { kind: "failed"; order: Order };

function leaseMs(): number {
  const raw = Number(process.env.BOOKING_PAYMENT_LEASE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : BOOKING_PAYMENT_LEASE_MS;
}

function bookable(order: Order, now = Date.now()): boolean {
  return order.status === "pending" && now < order.holdExpiresAt;
}

// The provider payment really is this order's payment under its stored
// identity. Anything else is never attached.
function bindsToOrder(order: Order, payment: ProviderPayment): boolean {
  return (
    payment.payment_id === order.paymentRequestId &&
    payment.metadata?.orderId === order.id &&
    payment.amount === order.amountCents &&
    payment.currency === order.currency
  );
}

async function processing(order: Order, reason: string, flag: boolean): Promise<EnsurePaymentResult> {
  if (flag) await flagForReconciliation(order.id, reason);
  return { kind: "processing", order, reason };
}

// Attach a retrieved/created provider payment to the order, field-scoped
// (attachPaymentId never rewrites status or resurrects a resolved order).
async function adopt(order: Order, payment: ProviderPayment): Promise<EnsurePaymentResult> {
  if (!bindsToOrder(order, payment)) {
    // Our own id came back bound to something else: never attach it.
    return processing(order, "payment_identity_mismatch", true);
  }
  const attached = await attachPaymentId(order.id, payment.payment_id);
  if (attached === "ok" || attached === "noop") {
    await clearPaymentAttempt(order.id).catch(() => {});
    const current = (await peekOrder(order.id)) ?? order;
    if (!payment.client_secret) return processing(current, "client_secret_unavailable", false);
    if (!bookable(current)) return { kind: "closed", order: current };
    return { kind: "ready", order: current, clientSecret: payment.client_secret };
  }
  if (attached === "conflict") {
    // A different payment is already attached — should be impossible with a
    // fixed identity; record it rather than guess.
    return processing(order, "payment_attach_conflict", true);
  }
  // not_found / error: the provider payment exists but the local association
  // did not land. A retry adopts it again by id.
  return processing(order, "payment_attach_failed", true);
}

// For an order whose payment is already attached: re-read it to hand the
// owner a client secret. No creation, no attach.
async function resume(order: Order, paymentId: string): Promise<EnsurePaymentResult> {
  const retrieved = await retrievePayment(paymentId);
  if (!retrieved.ok) {
    return processing(order, `attached_payment_${retrieved.category}`, retrieved.category === "not_found");
  }
  if (!bindsToOrder(order, retrieved.payment)) return processing(order, "payment_identity_mismatch", true);
  if (!retrieved.payment.client_secret) return processing(order, "client_secret_unavailable", false);
  return { kind: "ready", order, clientSecret: retrieved.payment.client_secret };
}

export async function ensureOrderPayment(order: Order): Promise<EnsurePaymentResult> {
  if (!bookable(order)) return { kind: "closed", order };
  if (order.paymentId) return resume(order, order.paymentId);

  const requestId = order.paymentRequestId;
  if (!requestId || !isValidPaymentId(requestId)) {
    // Orders reserved before Phase 1B.5 have no stored identity; never
    // create one now (that would be a payment under a new identifier).
    return processing(order, "no_payment_identity", true);
  }

  const token = await claimPaymentLease(order.id, leaseMs());
  if (!token) return { kind: "processing", order, reason: "creation_in_progress" };

  try {
    // Re-read under the lease: another request may have progressed it.
    const current = (await peekOrder(order.id)) ?? order;
    if (!bookable(current)) return { kind: "closed", order: current };
    if (current.paymentId) return resume(current, current.paymentId);

    // 1. Did an earlier request already create it (crash, lost response,
    //    failed association)? Retrieval by our id answers that.
    const existing = await retrievePayment(requestId);
    if (existing.ok) return adopt(current, existing.payment);
    if (existing.category !== "not_found") {
      return processing(current, "provider_unavailable", false);
    }

    // 2. Create under the SAME id. If an in-flight or stale request beat us
    //    to it, the provider rejects this as a duplicate.
    await markPaymentAttempt(current.id);
    const created = await createPayment({
      paymentId: requestId,
      amount: current.amountCents,
      currency: current.currency,
      metadata: {
        orderId: current.id,
        eventId: current.eventId,
        tierName: current.tierName,
        quantity: String(current.quantity),
        unitPrice: String(current.unitPriceCents),
      },
    });

    if (created.kind === "created") return adopt(current, created.payment);

    if (created.kind === "duplicate") {
      const again = await retrievePayment(requestId);
      if (again.ok) return adopt(current, again.payment);
      return processing(current, "payment_create_duplicate_unretrieved", true);
    }

    if (created.kind === "rejected") {
      // Definitive: no payment under this id. Fail the order and release its
      // seats — but only if no payment has been attached meanwhile.
      const tr = await transitionOrder(current.id, "pending", "failed", true, {
        requireNoPaymentId: true,
      });
      const latest = (await peekOrder(current.id)) ?? current;
      if (tr === "applied" || tr === "noop") return { kind: "failed", order: latest };
      if (tr === "has_payment" && latest.paymentId) return resume(latest, latest.paymentId);
      if (tr === "conflict") return { kind: "closed", order: latest };
      return processing(latest, "payment_reject_transition_failed", true);
    }

    // Uncertain: the payment may exist. Keep the reservation, record it, and
    // let a retry (same attempt, same id) resolve it by retrieval.
    return processing(current, `payment_create_uncertain_${created.reason}`, true);
  } finally {
    // Best effort. If Redis is failing, the release can fail too (with
    // auto-pipelining it may even share the failed request); the lease then
    // simply lapses after its TTL, and later retries resolve the payment by
    // its fixed id.
    await releasePaymentLease(order.id, token).catch(() => {});
  }
}
