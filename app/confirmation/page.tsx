"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface PaymentStatus {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
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

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const paymentId = extractPaymentId(searchParams);
  const [status, setStatus] = useState<PaymentStatus | null>(null);

  useEffect(() => {
    if (!paymentId) return;
    // Re-check status with our own server route rather than trusting
    // whatever the checkout page saw — Hyperswitch's backend is the
    // source of truth.
    fetch(`/api/payments/${paymentId}`)
      .then((res) => res.json())
      .then(setStatus);
  }, [paymentId]);

  if (!paymentId) {
    return <p>No payment found.</p>;
  }

  if (!status) {
    return <p>Checking payment status…</p>;
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">
        {status.status === "succeeded"
          ? "Payment successful"
          : `Status: ${status.status}`}
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Payment ID: {status.paymentId}
      </p>
      <p className="text-sm text-gray-600">
        Amount: {(status.amount / 100).toFixed(2)} {status.currency}
      </p>
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
