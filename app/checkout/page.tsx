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
import { formatCents } from "@/lib/format";

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

// Matches the widget's built-in dark theme to the app's own palette,
// so the hosted card iframe doesn't drop in as a bright rectangle on
// an otherwise dark page.
const HYPER_APPEARANCE = {
  theme: "midnight",
  variables: {
    colorPrimary: "#ff5a29",
    colorBackground: "#1d1a22",
    colorText: "#f3eee1",
    colorDanger: "#ff5a29",
    borderRadius: "2px",
  },
};

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
    return (
      <StatusCard title="Invalid order" tone="flame">
        Go back and pick an event.
        <Link href="/" className="mt-4 block underline underline-offset-4">
          ← All shows
        </Link>
      </StatusCard>
    );
  }

  if (error) {
    return (
      <StatusCard title="Couldn't reserve those tickets" tone="flame">
        {error}
        <Link
          href={`/events/${event.id}`}
          className="mt-4 block underline underline-offset-4"
        >
          Back to {event.name}
        </Link>
      </StatusCard>
    );
  }

  if (!order) {
    return <StatusCard title="Reserving your tickets…" tone="muted" />;
  }

  const expired = secondsLeft !== null && secondsLeft <= 0;

  if (expired) {
    return (
      <StatusCard title="Reservation expired" tone="flame">
        Your 10-minute hold ran out, so the tickets were released back into
        the pool.
        <Link
          href={`/events/${event.id}`}
          className="mt-4 block underline underline-offset-4"
        >
          Back to {event.name}
        </Link>
      </StatusCard>
    );
  }

  const minutes = secondsLeft !== null ? Math.floor(secondsLeft / 60) : 10;
  const seconds = secondsLeft !== null ? secondsLeft % 60 : 0;
  const urgent = secondsLeft !== null && secondsLeft <= 60;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-bold tracking-wide">
          CHECKOUT
        </h1>
        <div
          className={`font-mono text-2xl font-bold tabular-nums ${
            urgent ? "animate-pulse text-flame" : "text-text"
          }`}
        >
          {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
        </div>
      </div>
      <p className="text-right font-mono text-[11px] text-text-faint">
        RESERVATION HOLDS
      </p>

      {/* Receipt-style order summary */}
      <div className="grain relative mt-6 border border-ink-line bg-ink-raised p-5">
        <p className="font-display text-xl font-extrabold tracking-tight">
          {event.name}
        </p>
        <p className="font-mono text-xs text-text-faint">
          {event.artist} · {event.venue}
        </p>

        <div className="mt-4 border-t border-dashed border-ink-line pt-4">
          <div className="flex items-center justify-between font-mono text-sm">
            <span className="text-text-muted">
              {quantity} × {tier.name} @ {formatCents(tier.priceCents)}
            </span>
            <span>{formatCents(order.amountCents)}</span>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-ink-line pt-3">
          <span className="font-display text-sm font-bold tracking-wide text-text-faint">
            TOTAL
          </span>
          <span className="font-mono text-xl font-bold text-flame">
            {formatCents(order.amountCents)}
          </span>
        </div>
      </div>

      <div className="mt-6 border border-ink-line bg-ink-raised p-5">
        <HyperElements
          options={{ clientSecret: order.clientSecret, appearance: HYPER_APPEARANCE }}
          hyper={hyperPromise}
        >
          <PaymentForm total={formatCents(order.amountCents)} />
        </HyperElements>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "flame" | "muted";
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-ink-line bg-ink-raised p-6">
      <h1
        className={`font-display text-xl font-bold ${
          tone === "flame" ? "text-flame" : "text-text"
        }`}
      >
        {title}
      </h1>
      {children && (
        <div className="mt-2 font-body text-sm text-text-muted">{children}</div>
      )}
    </div>
  );
}

function PaymentForm({ total }: { total: string }) {
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
        className="mt-4 w-full bg-flame py-3 text-center font-display text-lg font-bold tracking-wide text-ink transition-transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50"
      >
        {isSubmitting ? "PROCESSING…" : `PAY ${total}`}
      </button>
      {errorMessage && (
        <p className="mt-2 font-mono text-xs text-flame">{errorMessage}</p>
      )}
    </form>
  );
}

export default function CheckoutPage() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-6 py-10 sm:py-16">
      <Suspense fallback={<StatusCard title="Loading…" tone="muted" />}>
        <CheckoutContent />
      </Suspense>
    </main>
  );
}
