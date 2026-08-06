"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import { getEvent } from "@/lib/events";
import { formatCents, formatDateStamp, formatTime } from "@/lib/format";
import { posterColorClasses } from "@/lib/theme";
import type { Order } from "@/lib/types";

interface PaymentStatus {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string> | null;
}

interface TicketData {
  orderId: string;
  eventId: string;
  tierName: string;
  quantity: number;
  amountCents: number;
}

type OrderLookup =
  | { kind: "loading" }
  | { kind: "found"; order: Order }
  | { kind: "not_found" };

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 5;

// Any Hyperswitch-initiated redirect — a 3DS challenge, or a
// redirect-based/wallet payment method like PayPal that never touches
// our own confirmPayment() call at all — lands here with
// `payment_intent_client_secret` in the URL instead of our own
// `payment_id` param (that one only shows up when we build the URL
// ourselves after an in-page confirmPayment() resolves without a
// redirect). The payment id is just the part of the client secret
// before "_secret_", so we can recover it either way.
function extractPaymentId(searchParams: URLSearchParams): string | null {
  const direct = searchParams.get("payment_id");
  if (direct) return direct;

  const clientSecret = searchParams.get("payment_intent_client_secret");
  if (clientSecret) return clientSecret.split("_secret_")[0];

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Ticket({
  ticket,
  initiallyRefunded,
}: {
  ticket: TicketData;
  initiallyRefunded: boolean;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [refunded, setRefunded] = useState(initiallyRefunded);
  const [isRefunding, setIsRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const event = getEvent(ticket.eventId);
  const colors = event ? posterColorClasses[event.posterColor] : null;
  const stamp = event ? formatDateStamp(event.date) : null;

  useEffect(() => {
    QRCode.toDataURL(ticket.orderId, {
      width: 220,
      margin: 0,
      color: { dark: "#1a1712", light: "#00000000" },
    }).then(setQrDataUrl);
  }, [ticket.orderId]);

  const handleRefund = async () => {
    setIsRefunding(true);
    setRefundError(null);

    const res = await fetch(`/api/orders/${ticket.orderId}/refund`, {
      method: "POST",
    });
    const data = await res.json();

    setIsRefunding(false);

    if (!res.ok) {
      setRefundError(data.error?.message ?? "Refund failed — try again.");
      return;
    }

    setRefunded(true);
  };

  return (
    <div className="mx-auto max-w-sm">
      <div
        className={`ticket-print-in grain relative overflow-hidden border border-black/10 bg-paper text-paper-ink shadow-[0_20px_50px_-15px_rgba(0,0,0,0.6)] ${
          refunded ? "grayscale" : ""
        }`}
      >
        {/* edge notches */}
        <span className="absolute top-[168px] -left-3 h-6 w-6 rounded-full bg-ink" />
        <span className="absolute top-[168px] -right-3 h-6 w-6 rounded-full bg-ink" />

        <div className="p-6 pb-5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold tracking-widest text-paper-ink/50">
              CONTICX · E-TICKET
            </span>
            {colors && (
              <span className={`h-2.5 w-2.5 rounded-full ${colors.bg}`} />
            )}
          </div>

          {event ? (
            <>
              <h1 className="mt-3 font-display text-4xl leading-[0.95] font-black tracking-tight">
                {event.name}
              </h1>
              <p className="mt-1 font-body text-sm text-paper-ink/70">
                {event.artist}
              </p>
              {stamp && (
                <p className="mt-3 font-mono text-[11px] font-bold tracking-wide text-paper-ink/70">
                  {stamp.weekday} {stamp.month} {stamp.day} · DOORS{" "}
                  {formatTime(event.date)} · {event.venue.toUpperCase()}
                </p>
              )}
            </>
          ) : (
            <h1 className="mt-3 font-display text-3xl font-black">
              Your ticket
            </h1>
          )}

          <p className="mt-3 font-mono text-xs font-bold text-paper-ink/70">
            {ticket.quantity} × {ticket.tierName} —{" "}
            {refunded ? "REFUNDED" : formatCents(ticket.amountCents)}
          </p>
        </div>

        {/* perforation */}
        <div
          className="relative h-4 w-full"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, var(--color-ink) 0 5px, transparent 5.5px)",
            backgroundSize: "18px 100%",
            backgroundRepeat: "repeat-x",
            backgroundPosition: "center",
          }}
        />

        <div className="flex items-center gap-5 p-6 pt-5">
          <div className="shrink-0">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Ticket QR code"
                width={96}
                height={96}
                className="bg-paper"
              />
            ) : (
              <div className="h-24 w-24 animate-pulse bg-paper-dim" />
            )}
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[10px] tracking-widest text-paper-ink/50">
              ORDER
            </p>
            <p className="truncate font-mono text-sm font-bold">
              {ticket.orderId}
            </p>
            <p className="mt-3 font-mono text-[10px] tracking-widest text-paper-ink/50">
              STATUS
            </p>
            <p className="font-mono text-sm font-bold">
              {refunded ? "VOID — REFUNDED" : "VALID FOR ENTRY"}
            </p>
          </div>
        </div>

        {refunded && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-12 border-4 border-flame-dim px-4 py-1 mix-blend-multiply"
          >
            <span className="font-display text-3xl font-black tracking-widest text-flame-dim">
              REFUNDED
            </span>
          </div>
        )}
      </div>

      {refunded ? (
        <p className="mt-6 text-center font-mono text-xs text-text-faint">
          This ticket is no longer valid for entry.
        </p>
      ) : (
        <div className="mt-6 text-center">
          <button
            onClick={handleRefund}
            disabled={isRefunding}
            className="border border-flame-dim px-5 py-2 font-mono text-xs font-bold tracking-wide text-flame transition-colors hover:bg-flame hover:text-ink disabled:opacity-50"
          >
            {isRefunding ? "CANCELLING…" : "CANCEL TICKET & REFUND"}
          </button>
          {refundError && (
            <p className="mt-2 font-mono text-xs text-flame">{refundError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const paymentId = extractPaymentId(searchParams);

  const [payment, setPayment] = useState<PaymentStatus | null>(null);
  const [orderLookup, setOrderLookup] = useState<OrderLookup>({
    kind: "loading",
  });

  useEffect(() => {
    if (!paymentId) return;

    // Scoped to this specific effect run rather than a ref shared
    // across separate effects — React (Strict Mode especially) can
    // mount/cleanup/mount an effect before its async work resolves,
    // and a cleanup flag shared with another effect can end up
    // permanently true, silently dropping every setState call below
    // forever. A plain closure variable resets correctly on every run.
    let cancelled = false;

    async function run() {
      // GET /api/payments/[id] hits Hyperswitch directly and, as a
      // side effect, reconciles our order store — a safety net
      // alongside the webhook in case delivery is delayed or missed
      // in this sandbox setup.
      const paymentRes = await fetch(`/api/payments/${paymentId}`);
      const paymentData: PaymentStatus = await paymentRes.json();
      if (cancelled) return;
      setPayment(paymentData);

      const orderId = paymentData.metadata?.orderId;
      if (!orderId) {
        setOrderLookup({ kind: "not_found" });
        return;
      }

      // The order store is authoritative — it's kept in sync by the
      // webhook and by the call above. Poll it briefly in case status
      // is still "pending" (payment settling asynchronously, webhook
      // not delivered yet). Only fall back to reconstructing from
      // payment metadata if this serverless instance never had the
      // order to begin with.
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        const orderRes = await fetch(`/api/orders/${orderId}`);
        if (cancelled) return;

        if (orderRes.status === 404) {
          setOrderLookup({ kind: "not_found" });
          return;
        }

        const orderData: Order = await orderRes.json();
        setOrderLookup({ kind: "found", order: orderData });

        if (orderData.status !== "pending") return; // terminal state reached
        await sleep(POLL_INTERVAL_MS);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [paymentId]);

  if (!paymentId) {
    return <StatusLine>No payment found.</StatusLine>;
  }

  if (!payment || orderLookup.kind === "loading") {
    return <StatusLine>Checking payment status…</StatusLine>;
  }

  if (orderLookup.kind === "found") {
    const { order } = orderLookup;
    if (order.status === "succeeded" || order.status === "refunded") {
      return (
        <Ticket
          ticket={{
            orderId: order.id,
            eventId: order.eventId,
            tierName: order.tierName,
            quantity: order.quantity,
            amountCents: order.amountCents,
          }}
          initiallyRefunded={order.status === "refunded"}
        />
      );
    }
    if (order.status === "pending") {
      return <StatusLine>Still processing your payment — check back in a moment.</StatusLine>;
    }
    return <StatusLine>Order status: {order.status}</StatusLine>;
  }

  // Fallback: this instance never had the order (cold start, or a
  // different instance created it). Reconstruct ticket display data
  // from the payment's own metadata instead — it travels with the
  // payment regardless of which serverless instance handles the
  // request. Refund status isn't part of that metadata (it's set once
  // at payment creation and never updated), so this path always shows
  // an un-refunded ticket — an acceptable gap for what's already
  // documented as a rare last resort.
  if (payment.status === "succeeded" && payment.metadata) {
    const { orderId, eventId, tierName, quantity } = payment.metadata;
    return (
      <Ticket
        ticket={{
          orderId,
          eventId,
          tierName,
          quantity: Number(quantity),
          amountCents: payment.amount,
        }}
        initiallyRefunded={false}
      />
    );
  }

  return (
    <StatusLine>
      Status: {payment.status}
      <span className="mt-1 block font-mono text-xs text-text-faint">
        Payment ID: {payment.paymentId}
      </span>
    </StatusLine>
  );
}

function StatusLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm border border-ink-line bg-ink-raised p-6 text-center">
      <p className="font-body text-sm text-text-muted">{children}</p>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <Suspense fallback={<StatusLine>Loading…</StatusLine>}>
        <ConfirmationContent />
      </Suspense>
    </main>
  );
}
