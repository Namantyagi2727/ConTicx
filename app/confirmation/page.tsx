"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import { getEvent } from "@/lib/events";
import { formatCents, formatEventDate } from "@/lib/format";

interface PaymentStatus {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string> | null;
}

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

function Ticket({ payment }: { payment: PaymentStatus }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const orderId = payment.metadata?.orderId;
  const eventId = payment.metadata?.eventId;
  const tierName = payment.metadata?.tierName;
  const quantity = payment.metadata?.quantity;

  // Event details come from the static catalog via metadata.eventId
  // rather than the in-memory order store, so the ticket still renders
  // correctly even if that store lost the order (cold start, redeploy).
  const event = eventId ? getEvent(eventId) : undefined;

  useEffect(() => {
    if (!orderId) return;
    QRCode.toDataURL(orderId, { width: 220 }).then(setQrDataUrl);
  }, [orderId]);

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
            {quantity} × {tierName}
          </p>
          <p className="text-sm">Total paid: {formatCents(payment.amount)}</p>
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

      <p className="mt-4 text-xs text-gray-400">Order ID: {orderId}</p>
    </div>
  );
}

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const paymentId = extractPaymentId(searchParams);
  const [payment, setPayment] = useState<PaymentStatus | null>(null);

  useEffect(() => {
    if (!paymentId) return;
    // Re-check status with our own server route rather than trusting
    // whatever the checkout page saw — Hyperswitch's backend is the
    // source of truth.
    fetch(`/api/payments/${paymentId}`)
      .then((res) => res.json())
      .then(setPayment);
  }, [paymentId]);

  if (!paymentId) {
    return <p>No payment found.</p>;
  }

  if (!payment) {
    return <p>Checking payment status…</p>;
  }

  if (payment.status === "succeeded") {
    return <Ticket payment={payment} />;
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
