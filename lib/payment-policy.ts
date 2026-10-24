// Shared payment-reconciliation policy used by every path that maps
// authoritative provider state onto a local order: the webhook handler, the
// payment-status reconciliation read, and lazy hold expiry. Keeping binding
// and status mapping in ONE place is what makes those three paths behave
// identically. This is deliberately NOT a workflow engine — just the two
// pure decisions: is this provider payment bound to this order, and what
// single transition (if any) does its status justify. The orchestration
// (retrieve, apply the transition, record reconciliation) lives in the
// store, next to the atomic operations it depends on.

import type { ProviderPayment } from "./hyperswitch";
import type { Order, OrderStatus } from "./types";

export type BindOutcome =
  | { kind: "ok" }
  | { kind: "retry"; reason: string }
  | { kind: "reject"; reason: string };

// Verifies, two-way, that `pp` is the payment for `order`. `order` is the
// stored order already read (no reaping); `requestedPaymentId` is the id the
// caller used to retrieve `pp` — the webhook body's id, the payment-status
// path id, or order.paymentId for expiry — so a payment can never be bound
// to an order that does not point back at that same id.
//
// Merchant identity (carry-forward A): when HYPERSWITCH_MERCHANT_ID is
// configured, the provider response MUST carry exactly that id — a MISSING
// merchant id fails binding too, not only a mismatched one. When it is not
// configured the merchant check is skipped and only the association, amount,
// and currency checks apply. No other provider field is validated (there is
// no profile-id validation).
export function bindPaymentToOrder(
  order: Order,
  pp: ProviderPayment,
  requestedPaymentId: string
): BindOutcome {
  if (pp.payment_id !== requestedPaymentId) {
    return { kind: "reject", reason: "returned_payment_id_mismatch" };
  }

  const expectedMerchant = process.env.HYPERSWITCH_MERCHANT_ID;
  if (expectedMerchant && pp.merchant_id !== expectedMerchant) {
    return { kind: "reject", reason: "merchant_mismatch_or_missing" };
  }

  if (pp.metadata?.orderId !== order.id) {
    return { kind: "reject", reason: "order_association_mismatch" };
  }

  if (!order.paymentId) {
    // The order exists but its payment id is not attached yet (the
    // create -> attach window). Transient; retry rather than reject.
    return { kind: "retry", reason: "association_not_ready" };
  }
  if (order.paymentId !== requestedPaymentId) {
    return { kind: "reject", reason: "payment_order_mismatch" };
  }

  if (order.amountCents !== pp.amount) {
    return { kind: "reject", reason: "amount_mismatch" };
  }
  if (order.currency !== pp.currency) {
    return { kind: "reject", reason: "currency_mismatch" };
  }

  return { kind: "ok" };
}

export type Decision =
  | { action: "succeed"; to: OrderStatus; release: boolean; reason: string }
  | { action: "release"; to: OrderStatus; release: boolean; reason: string }
  | { action: "retain"; reason: string }
  | { action: "pending"; reason: string };

// Maps an AUTHORITATIVE Hyperswitch payment status to the single order
// transition it justifies — the same mapping on every path, driven ONLY by
// the status, never an event name or an HTTP response code.
//
// Terminal classification follows Hyperswitch's own
// IntentStatus::is_in_terminal_state (crates/common_enums/src/enums.rs):
// succeeded, failed, cancelled, cancelled_post_capture, partially_captured,
// expired.
//
//   succeeded           -> paid (keep the seat). The ONLY authoritative
//                          success.
//   cancelled | expired -> release. Terminal AND unpaid (voided / expired
//                          before capture), so the seat is genuinely free.
//   failed              -> RETAIN. Terminal at the intent level, but the
//                          audit established a failed payment may still be
//                          retried; no reliable finality rule is implemented
//                          (we do not assume profile settings or guess a
//                          cutoff), so we do not release.
//   anything else       -> no terminal outcome (processing, review,
//                          requires_*, and the captured-funds cases
//                          cancelled_post_capture / partially_*). Never
//                          guessed.
export function decideFromStatus(status: string): Decision {
  switch (status) {
    case "succeeded":
      return { action: "succeed", to: "succeeded", release: false, reason: "succeeded" };
    case "cancelled":
      return { action: "release", to: "failed", release: true, reason: "cancelled" };
    case "expired":
      return { action: "release", to: "expired", release: true, reason: "expired" };
    case "failed":
      return { action: "retain", reason: "payment_failed_retryable" };
    default:
      return { action: "pending", reason: `non_terminal_${sanitizeStatus(status)}` };
  }
}

function sanitizeStatus(status: string): string {
  return status.replace(/[^a-z0-9_]/gi, "").slice(0, 32) || "unknown";
}
