"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import { getEvent } from "@/lib/events";
import { formatCents, formatEventDate } from "@/lib/format";
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

// After a 3DS challenge, Hyperswitch redirects here with
// `payment_intent_client_secret` in the URL instead of our own
// `payment_id` param. The payment id is just the part of the client
// secret before "_secret_", so we can recover it either way.
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

function Ticket({ ticket }: { ticket: TicketData }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const event = getEvent(ticket.eventId);

  useEffect(() => {
    QRCode.toDataURL(ticket.orderId, { width: 220 }).then(setQrDataUrl);
  }, [ticket.orderId]);

  return (
    <div className="rounded-lg border border-gray-200 p-6 text-center">
      <h1 className="text-xl font-semibold text-green-700">
        Payment successful
      </h1>

      {event && (
        <div className="mt-4 text-left">
          <p className="font-medium">{event.name}</p>
          <p className="text-sm text-gray-600">
            {formatEventDate(event.date)} · {event.venue}
          </p>
          <p className="mt-2 text-sm">
            {ticket.quantity} × {ticket.tierName}
          </p>
          <p className="text-sm">
            Total paid: {formatCents(ticket.amountCents)}
          </p>
        </div>
      )}

      {qrDataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qrDataUrl}
          alt="Ticket QR code"
          className="mx-auto mt-4"
          width={220}
          height={220}
        />
      )}

      <p className="mt-4 text-xs text-gray-400">Order ID: {ticket.orderId}</p>
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
  const cancelled = useRef(false);

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (!paymentId) return;

    async function run() {
      // GET /api/payments/[id] hits Hyperswitch directly and, as a
      // side effect, reconciles our order store — a safety net
      // alongside the webhook in case delivery is delayed or missed
      // in this sandbox setup.
      const paymentRes = await fetch(`/api/payments/${paymentId}`);
      const paymentData: PaymentStatus = await paymentRes.json();
      if (cancelled.current) return;
      setPayment(paymentData);

      const orderId = paymentData.metadata?.orderId;
      if (!orderId) {
        setOrderLookup({ kind: "not_found" });
        return;
      }

      // The in-memory order store is authoritative — it's kept in
      // sync by the webhook and by the call above. Poll it briefly in
      // case status is still "pending" (payment settling
      // asynchronously, webhook not delivered yet). Only fall back to
      // reconstructing from payment metadata if this serverless
      // instance never had the order to begin with (a different
      // instance created it).
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        const orderRes = await fetch(`/api/orders/${orderId}`);
        if (cancelled.current) return;

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
  }, [paymentId]);

  if (!paymentId) {
    return <p>No payment found.</p>;
  }

  if (!payment || orderLookup.kind === "loading") {
    return <p>Checking payment status…</p>;
  }

  if (orderLookup.kind === "found") {
    const { order } = orderLookup;
    if (order.status === "succeeded") {
      return (
        <Ticket
          ticket={{
            orderId: order.id,
            eventId: order.eventId,
            tierName: order.tierName,
            quantity: order.quantity,
            amountCents: order.amountCents,
          }}
        />
      );
    }
    if (order.status === "pending") {
      return <p>Still processing your payment — check back in a moment.</p>;
    }
    return <p>Order status: {order.status}</p>;
  }

  // Fallback: this instance never had the order (cold start, or a
  // different instance created it). Reconstruct ticket display data
  // from the payment's own metadata instead — it travels with the
  // payment regardless of which serverless instance handles the
  // request.
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
      />
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">Status: {payment.status}</h1>
      <p className="mt-2 text-sm text-gray-600">Payment ID: {payment.paymentId}</p>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <main className="mx-auto max-w-md p-8">
      <Suspense fallback={<p>Loading…</p>}>
        <ConfirmationContent />
      </Suspense>
    </main>
  );
}
