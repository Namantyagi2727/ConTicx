"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { loadHyper } from "@juspay-tech/hyper-js";
import {
  HyperElements,
  UnifiedCheckout,
  useHyper,
  useWidgets,
} from "@juspay-tech/react-hyper-js";

// Load Hyper once, outside the component, so it isn't recreated on every render.
// env: "SANDBOX" points the SDK at Hyperswitch's hosted sandbox API.
// Guarded to the browser only — loadHyper touches `document`, which
// doesn't exist during Next's server-side prerender of this client page.
const hyperPromise =
  typeof window !== "undefined"
    ? loadHyper(
        process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY as string,
        { env: "SANDBOX" }
      )
    : null;

export default function CheckoutPage() {
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  // Ask our own server for a fresh payment intent as soon as the page loads.
  // The secret key used to create it never comes near the browser.
  useEffect(() => {
    fetch("/api/payments/create", { method: "POST" })
      .then((res) => res.json())
      .then((data) => setClientSecret(data.clientSecret));
  }, []);

  if (!clientSecret) {
    return <main className="p-8">Setting up payment…</main>;
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="mb-6 text-xl font-semibold">ConTicx — test checkout</h1>
      <HyperElements options={{ clientSecret }} hyper={hyperPromise}>
        <CheckoutForm />
      </HyperElements>
    </main>
  );
}

function CheckoutForm() {
  const hyper = useHyper();
  const widgets = useWidgets();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hyper || !widgets) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    // redirect: "if_required" keeps the shopper on this page unless the
    // connector needs a redirect (e.g. a 3DS challenge).
    const { error, status, payment_id } = await hyper.confirmPayment({
      elements: widgets,
      confirmParams: {
        return_url: `${window.location.origin}/confirmation`,
      },
      redirect: "if_required",
    });

    setIsSubmitting(false);

    if (error) {
      setErrorMessage(error.message ?? "Payment failed");
      return;
    }

    router.push(`/confirmation?payment_id=${payment_id}&status=${status}`);
  };

  return (
    <form onSubmit={handleSubmit}>
      <UnifiedCheckout id="unified-checkout" />
      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-4 w-full rounded-md bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isSubmitting ? "Processing…" : "Pay $50.00"}
      </button>
      {errorMessage && (
        <p className="mt-2 text-sm text-red-600">{errorMessage}</p>
      )}
    </form>
  );
}
