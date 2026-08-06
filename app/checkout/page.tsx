"use client";

import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { loadHyper } from "@juspay-tech/hyper-js";
import {
  HyperElements,
  UnifiedCheckout,
  useHyper,
  useWidgets,
} from "@juspay-tech/react-hyper-js";
import { getEvent } from "@/lib/events";
import { formatCents, formatEventDate } from "@/lib/format";

// Load Hyper once, outside the component, so it isn't recreated on every render.
// Guarded to the browser only — loadHyper touches `document`, which
// doesn't exist during Next's server-side prerender of this client page.
const hyperPromise =
  typeof window !== "undefined"
    ? loadHyper(
        process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY as string,
        { env: "SANDBOX" }
      )
    : null;

interface OrderCreateResponse {
  clientSecret: string;
  paymentId: string;
  orderId: string;
  holdExpiresAt: number;
  amountCents: number;
}

function CheckoutContent() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get("eventId");
  const tierName = searchParams.get("tierName");
  const quantity = Number(searchParams.get("quantity"));

  const event = eventId ? getEvent(eventId) : undefined;
  const tier = event?.tiers.find((t) => t.name === tierName);

  const [order, setOrder] = useState<OrderCreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Create the inventory hold + Hyperswitch payment as soon as we land here.
  useEffect(() => {
    if (!event || !tier || !quantity) return;

    fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id, tierName: tier.name, quantity }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not reserve tickets");
        setOrder(data);
      })
      .catch((err) => setError(err.message));
    // event/tier are derived from the same query params on every render,
    // so keying off the primitives avoids re-firing on object identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, tierName, quantity]);

  // Live countdown to the hold expiring.
  useEffect(() => {
    if (!order) return;
    const tick = () =>
      setSecondsLeft(
        Math.max(0, Math.round((order.holdExpiresAt - Date.now()) / 1000))
      );
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [order]);

  if (!event || !tier || !Number.isInteger(quantity) || quantity < 1) {
    return <p>Invalid order — go back and pick an event.</p>;
  }

  if (error) {
    return (
      <div>
        <p className="text-red-600">{error}</p>
        <Link href={`/events/${event.id}`} className="mt-4 inline-block underline">
          Back to {event.name}
        </Link>
      </div>
    );
  }

  if (!order) {
    return <p>Reserving your tickets…</p>;
  }

  const expired = secondsLeft !== null && secondsLeft <= 0;

  if (expired) {
    return (
      <div>
        <h1 className="text-xl font-semibold">Reservation expired</h1>
        <p className="mt-2 text-gray-600">
          Your 10-minute hold ran out, so the tickets were released back into
          the pool.
        </p>
        <Link href={`/events/${event.id}`} className="mt-4 inline-block underline">
          Back to {event.name}
        </Link>
      </div>
    );
  }

  const minutes = secondsLeft !== null ? Math.floor(secondsLeft / 60) : 10;
  const seconds = secondsLeft !== null ? secondsLeft % 60 : 0;

  return (
    <div>
      <h1 className="text-xl font-semibold">Checkout</h1>

      <div className="mt-4 rounded-md border border-gray-200 p-4">
        <p className="font-medium">{event.name}</p>
        <p className="text-sm text-gray-600">
          {formatEventDate(event.date)} · {event.venue}
        </p>
        <p className="mt-2 text-sm">
          {quantity} × {tier.name} ({formatCents(tier.priceCents)} each)
        </p>
        <p className="mt-1 font-medium">Total: {formatCents(order.amountCents)}</p>
      </div>

      <p className="mt-4 text-sm text-gray-600">
        Reservation held for{" "}
        <span className="font-mono">
          {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
        </span>
      </p>

      <div className="mt-4">
        <HyperElements
          options={{ clientSecret: order.clientSecret }}
          hyper={hyperPromise}
        >
          <PaymentForm />
        </HyperElements>
      </div>
    </div>
  );
}

function PaymentForm() {
  const hyper = useHyper();
  const widgets = useWidgets();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Wallet payment methods (PayPal, GPay, Apple Pay) render as their own
  // button inside the widget and handle their own click-to-redirect
  // internally — they don't go through handleSubmit/confirmPayment below
  // at all, so confirmParams.return_url never reaches them. Hyperswitch
  // docs call walletReturnUrl a mandatory option for these flows; without
  // it, a wallet button has nowhere valid to send the shopper back to.
  // Memoized so the widget doesn't see a new options object (and
  // potentially reset) on every unrelated re-render (isSubmitting, etc).
  const unifiedCheckoutOptions = useMemo(
    () => ({
      wallets: {
        walletReturnUrl: `${window.location.origin}/confirmation`,
      },
    }),
    []
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hyper || !widgets) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    // redirect: "if_required" keeps the shopper on this page unless the
    // connector needs a redirect (e.g. a 3DS challenge).
    const { error, payment_id } = await hyper.confirmPayment({
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

    router.push(`/confirmation?payment_id=${payment_id}`);
  };

  return (
    <form onSubmit={handleSubmit}>
      <UnifiedCheckout id="unified-checkout" options={unifiedCheckoutOptions} />
      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-4 w-full rounded-md bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isSubmitting ? "Processing…" : "Pay"}
      </button>
      {errorMessage && (
        <p className="mt-2 text-sm text-red-600">{errorMessage}</p>
      )}
    </form>
  );
}

export default function CheckoutPage() {
  return (
    <main className="mx-auto max-w-md p-8">
      <Suspense fallback={<p>Loading…</p>}>
        <CheckoutContent />
      </Suspense>
    </main>
  );
}
