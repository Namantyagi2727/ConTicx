"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { BROWSE_ONLY_NOTE, ensureGuestSession, newBookingAttemptId } from "@/lib/guest-client";
import { Icon } from "@/components/Icon";

// Load Hyper lazily and once: only when a booking is ready to pay. A page
// that never gets that far — the browse-only demo, a refused or failed
// booking — therefore never loads the SDK or contacts Hyperswitch, and a
// missing publishable key cannot crash the page at module load. Browser
// only: loadHyper touches `document`.
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY;
let hyperPromise: ReturnType<typeof loadHyper> | null = null;
function getHyper(): ReturnType<typeof loadHyper> | null {
  if (!hyperPromise && typeof window !== "undefined" && PUBLISHABLE_KEY) {
    hyperPromise = loadHyper(PUBLISHABLE_KEY, { env: "SANDBOX" });
  }
  return hyperPromise;
}

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

// How long to wait for the widget's confirm call before handing the shopper
// to the confirmation page, which reports the provider-verified outcome.
const CONFIRM_WATCHDOG_MS = 45_000;

// The widget's own error text can be a raw provider message. Keep ordinary
// card messages (they tell the shopper what to fix) and replace the rest.
function friendlyPaymentError(message: string | undefined): string {
  if (!message || message.length > 160 || /manual_retry|status failed|client_secret/i.test(message)) {
    return "That payment didn't go through.";
  }
  return message;
}

// Hyperswitch sandbox test cards, from the provider's published list for its
// dummy connector (the sandbox's test processor). No real money moves.
const TEST_CARDS = [
  { label: "Payment succeeds", number: "4242 4242 4242 4242" },
  { label: "Payment is declined", number: "4000 0000 0000 0002" },
];

function SandboxCardHelp() {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(number: string) {
    try {
      await navigator.clipboard.writeText(number.replace(/ /g, ""));
      setCopied(number);
      setTimeout(() => setCopied((c) => (c === number ? null : c)), 1800);
    } catch {
      // Clipboard blocked: the number is on screen to type instead.
    }
  }

  return (
    <div className="mb-5 rounded-sm border border-acid/40 bg-acid/[0.06] p-4">
      <p className="font-body text-sm font-semibold text-acid">Sandbox payment — no real money</p>
      <p className="mt-1 font-body text-sm text-text-muted">
        Use a test card with any future expiry and any 3-digit CVC. Don&apos;t enter a real card.
      </p>
      <ul className="mt-3 divide-y divide-ink-line border-y border-ink-line">
        {TEST_CARDS.map((card) => (
          <li key={card.number} className="flex items-center justify-between gap-3 py-1.5">
            <div>
              <p className="font-mono text-sm font-bold text-text">{card.number}</p>
              <p className="font-body text-xs text-text-muted">{card.label}</p>
            </div>
            <button
              type="button"
              onClick={() => copy(card.number)}
              className="inline-flex min-h-11 items-center gap-1.5 px-2 font-body text-sm text-text-muted transition-colors hover:text-text"
            >
              <Icon name={copied === card.number ? "check" : "copy"} size={16} />
              {copied === card.number ? "Copied" : "Copy"}
              <span className="sr-only"> {card.number}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">
        {copied ? `Copied ${copied}` : ""}
      </p>
    </div>
  );
}

interface OrderCreateResponse {
  clientSecret: string;
  orderId: string;
  holdExpiresAt: number;
  feeCents: number;
  amountCents: number;
}

// What one checkout attempt resolved to (see POST /api/orders).
type BookingResult =
  | { kind: "ready"; order: OrderCreateResponse }
  | { kind: "pending"; orderId?: string; holdExpiresAt?: number; refused?: boolean }
  | { kind: "conflict"; message: string }
  | { kind: "closed"; orderId: string; orderStatus: string }
  | { kind: "error"; message: string }
  | { kind: "browse_only" };

const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOKING_RETRY_MS = 2000;
const MAX_BOOKING_TRIES = 6;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Establishes the guest session FIRST, so the booking request already carries
// the cookie that will own the order (see /api/guest-session), then books
// this checkout attempt. Every request — including retries after a lost or
// garbled response and while payment setup is still "processing" — sends
// the SAME attemptId, so the server returns the same order and hold rather
// than booking again. It never mints a new attempt on an uncertain outcome.
async function createBooking(
  attemptId: string,
  eventId: string,
  tierName: string,
  quantity: number
): Promise<BookingResult> {
  const session = await ensureGuestSession();
  if (session === "browse_only") return { kind: "browse_only" };
  if (session !== "ok") {
    return {
      kind: "error",
      message: "We couldn't start a secure session in this browser — check that cookies are allowed",
    };
  }

  let pending: { orderId?: string; holdExpiresAt?: number } = {};
  for (let attempt = 0; attempt < MAX_BOOKING_TRIES; attempt++) {
    let res: Response;
    let data: Record<string, unknown>;
    try {
      res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, tierName, quantity, attemptId }),
      });
      data = await res.json();
    } catch {
      // The request may or may not have reached us: retry the same attempt.
      await sleep(BOOKING_RETRY_MS);
      continue;
    }

    if (res.status === 401) {
      return {
        kind: "error",
        message: "Your browser session wasn't available — check that cookies are allowed, then try again",
      };
    }
    switch (data.code) {
      case "browse_only":
        return { kind: "browse_only" };
      case "ready":
        return { kind: "ready", order: data as unknown as OrderCreateResponse };
      case "processing":
        pending = {
          orderId: data.orderId as string | undefined,
          holdExpiresAt: data.holdExpiresAt as number | undefined,
        };
        await sleep(typeof data.retryAfterMs === "number" ? data.retryAfterMs : BOOKING_RETRY_MS);
        continue;
      case "attempt_conflict":
        return { kind: "conflict", message: String(data.error ?? "This booking can't be changed") };
      case "attempt_closed":
        return { kind: "closed", orderId: String(data.orderId), orderStatus: String(data.orderStatus) };
      case "payment_setup_failed":
        // The provider refused this attempt's payment setup, but the seats
        // stay held for it (a refusal does not prove no payment exists). Do
        // not loop; let the shopper retry this same booking deliberately.
        return {
          kind: "pending",
          refused: true,
          orderId: data.orderId as string | undefined,
          holdExpiresAt: data.holdExpiresAt as number | undefined,
        };
    }
    if (res.status === 503) {
      await sleep(BOOKING_RETRY_MS);
      continue;
    }
    return { kind: "error", message: String(data.error ?? "Could not reserve tickets") };
  }
  return { kind: "pending", ...pending };
}

function checkoutHref(eventId: string, tierName: string, quantity: number, attemptId: string) {
  const params = new URLSearchParams({ eventId, tierName, quantity: String(quantity), attempt: attemptId });
  return `/checkout?${params.toString()}`;
}

function CheckoutContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const eventId = searchParams.get("eventId");
  const tierName = searchParams.get("tierName");
  const quantity = Number(searchParams.get("quantity"));
  const attemptParam = searchParams.get("attempt");
  const attemptId = attemptParam && ATTEMPT_RE.test(attemptParam) ? attemptParam : null;

  const event = eventId ? getEvent(eventId) : undefined;
  const tier = event?.tiers.find((t) => t.name === tierName);

  const [result, setResult] = useState<BookingResult | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const order = result?.kind === "ready" ? result.order : null;

  // A checkout URL without a booking attempt (an old link, or typed by hand)
  // gets ONE new attempt, written into the URL so a reload resumes it. The
  // ref keeps that id stable across Strict Mode's effect re-run.
  const generatedAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    if (attemptId || !event || !tier || !Number.isInteger(quantity) || quantity < 1) return;
    generatedAttemptRef.current ??= newBookingAttemptId();
    router.replace(checkoutHref(event.id, tier.name, quantity, generatedAttemptRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, eventId, tierName, quantity]);

  // One in-flight booking per checkout attempt. React Strict Mode runs the
  // effect below setup → cleanup → setup on the SAME component instance, and
  // refs survive that cycle, so the second setup finds the first setup's
  // in-flight booking here and subscribes to it instead of POSTing again.
  // The server is idempotent per attempt as well (Phase 1B.5), so even a
  // reload or a second request for this attempt resumes the same order.
  const bookingRef = useRef<{ key: string; promise: Promise<BookingResult> } | null>(null);

  // Book (or resume) this attempt as soon as we land here.
  useEffect(() => {
    if (!event || !tier || !quantity || !attemptId) return;

    const key = `${attemptId}|${event.id}|${tier.name}|${quantity}|${retryNonce}`;
    if (bookingRef.current?.key !== key) {
      bookingRef.current = { key, promise: createBooking(attemptId, event.id, tier.name, quantity) };
    }

    // Cleanup only silences THIS setup's subscription; it never discards the
    // booking itself, so the setup that survives Strict Mode's remount still
    // receives the result. After a real unmount nothing is set.
    let active = true;
    bookingRef.current.promise.then(
      (outcome) => {
        if (active) setResult(outcome);
      },
      () => {
        if (active) setResult({ kind: "error", message: "Could not reserve tickets" });
      }
    );
    return () => {
      active = false;
    };
    // event/tier are derived from the same query params on every render,
    // so keying off the primitives avoids re-firing on object identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, tierName, quantity, attemptId, retryNonce]);

  // A paid attempt goes straight to its ticket.
  useEffect(() => {
    if (result?.kind !== "closed") return;
    if (result.orderStatus === "succeeded" || result.orderStatus === "refunded") {
      router.replace(`/confirmation/${encodeURIComponent(result.orderId)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Live countdown to the hold expiring — always the ORIGINAL hold from the
  // server, so resuming a booking never resets the window.
  const holdExpiresAt =
    result?.kind === "ready"
      ? result.order.holdExpiresAt
      : result?.kind === "pending"
        ? result.holdExpiresAt
        : undefined;
  useEffect(() => {
    if (!holdExpiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((holdExpiresAt - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [holdExpiresAt]);

  if (!event || !tier || !Number.isInteger(quantity) || quantity < 1) {
    return (
      <StatusCard title="That's not a valid order" tone="flame">
        We couldn&apos;t tell which tickets you meant. Head back and pick an
        event to start over.
        <Link href="/" className="mt-4 inline-flex min-h-11 items-center gap-1.5 underline underline-offset-4">
          <Icon name="arrow-left" size={16} /> All shows
        </Link>
      </StatusCard>
    );
  }

  const newBookingLink = (
    <Link href={`/events/${event.id}`} className="mt-4 block underline underline-offset-4">
      Start a new booking for {event.name}
    </Link>
  );

  if (result?.kind === "browse_only") {
    return (
      <StatusCard title="Booking is off in this demo" tone="muted">
        {BROWSE_ONLY_NOTE}
        <Link href={`/events/${event.id}`} className="mt-4 block underline underline-offset-4">
          Back to {event.name}
        </Link>
      </StatusCard>
    );
  }

  if (result?.kind === "error") {
    return (
      <StatusCard title="Couldn't reserve those tickets" tone="flame">
        {result.message}. Nothing was charged.
        {newBookingLink}
      </StatusCard>
    );
  }

  if (result?.kind === "conflict") {
    return (
      <StatusCard title="This booking can't be changed" tone="flame">
        {result.message}
        {newBookingLink}
      </StatusCard>
    );
  }

  if (result?.kind === "closed") {
    if (result.orderStatus === "succeeded" || result.orderStatus === "refunded") {
      return (
        <StatusCard title="You already paid for this booking" tone="muted" showSpinner>
          Opening your ticket…
        </StatusCard>
      );
    }
    return (
      <StatusCard title="This booking has ended" tone="flame">
        {result.orderStatus === "expired"
          ? "Its hold ran out before payment finished."
          : "Its payment didn't go through."}{" "}
        These tickets aren&apos;t reserved for you any more.
        {newBookingLink}
      </StatusCard>
    );
  }

  if (result?.kind === "pending") {
    return (
      <StatusCard
        title={result.refused ? "We couldn't set up payment yet" : "Still setting up your payment"}
        tone="muted"
      >
        Your tickets stay reserved for this booking
        {secondsLeft !== null ? ` (${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} left)` : ""}
        . We haven&apos;t charged anything. Try again to pick up this same
        booking — trying again never books twice.
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setRetryNonce((n) => n + 1);
          }}
          className="mt-4 block bg-flame px-4 py-2 font-display text-sm font-bold tracking-wide text-ink"
        >
          TRY AGAIN
        </button>
        {newBookingLink}
      </StatusCard>
    );
  }

  if (!order) {
    return (
      <StatusCard title="Reserving your tickets…" tone="muted" showSpinner>
        Holding your seats while we set up payment — one moment.
      </StatusCard>
    );
  }

  const expired = secondsLeft !== null && secondsLeft <= 0;

  if (expired) {
    return (
      <StatusCard title="Your hold just expired" tone="flame">
        Ten minutes ran out, so we released those tickets back to other
        buyers. No charge was made — head back to grab a new hold.
        <Link
          href={`/events/${event.id}`}
          className="mt-4 inline-block bg-flame px-4 py-2 font-display text-sm font-bold tracking-wide text-ink no-underline"
        >
          BACK TO {event.name.toUpperCase()}
        </Link>
      </StatusCard>
    );
  }

  const minutes = secondsLeft !== null ? Math.floor(secondsLeft / 60) : 10;
  const seconds = secondsLeft !== null ? secondsLeft % 60 : 0;
  const urgent = secondsLeft !== null && secondsLeft <= 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const subtotalCents = order.amountCents - order.feeCents;
  const hyper = getHyper();

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-bold tracking-wide">
          CHECKOUT
        </h1>
        <div
          role="timer"
          aria-label="Time left on your seat hold"
          className={`font-mono text-2xl font-bold tabular-nums ${
            urgent ? "animate-pulse text-flame" : "text-text"
          }`}
        >
          {clock}
        </div>
      </div>
      <p className="mt-1 text-right font-body text-sm text-text-muted">
        We&apos;re holding your tickets for {clock}
        {urgent ? " — check out now, they're about to be released." : "."}
      </p>

      {/* Receipt-style order summary */}
      <div className="grain relative mt-6 border border-ink-line bg-ink-raised p-5">
        <p className="font-display text-xl font-extrabold tracking-tight">
          {event.name}
        </p>
        <p className="font-mono text-xs text-text-faint">
          {event.artist} · {event.venue}
        </p>

        <div className="mt-4 space-y-2 border-t border-dashed border-ink-line pt-4 font-mono text-sm">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">
              {quantity} × {tier.name} @ {formatCents(tier.priceCents)}
            </span>
            <span>{formatCents(subtotalCents)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Service fee</span>
            <span>{formatCents(order.feeCents)}</span>
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
        {hyper ? (
          <HyperElements
            options={{ clientSecret: order.clientSecret, appearance: HYPER_APPEARANCE }}
            hyper={hyper}
          >
            <PaymentForm
              total={formatCents(order.amountCents)}
              orderId={order.orderId}
              eventId={event.id}
              eventName={event.name}
            />
          </HyperElements>
        ) : (
          <p className="font-body text-sm text-text-muted">
            The payment widget isn&apos;t configured on this deployment
            (missing publishable key), so this booking can&apos;t be paid
            here. Your seats stay held until the hold runs out.
          </p>
        )}
      </div>

      {/* Reloading this page resumes this same booking; a separate booking
          is a deliberate, different action. */}
      <p className="mt-4 text-center font-body text-sm text-text-faint">
        Reloading keeps this booking and its hold.{" "}
        <Link href={`/events/${event.id}`} className="text-text underline underline-offset-2">
          Start a separate booking
        </Link>
      </p>
    </div>
  );
}

function StatusCard({
  title,
  tone,
  showSpinner,
  children,
}: {
  title: string;
  tone: "flame" | "muted";
  showSpinner?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-ink-line bg-ink-raised p-6">
      <h1
        className={`flex items-center gap-2 font-display text-xl font-bold ${
          tone === "flame" ? "text-flame" : "text-text"
        }`}
      >
        {showSpinner && <span className="spinner" aria-hidden />}
        {title}
      </h1>
      {children && (
        <div className="mt-2 font-body text-sm text-text-muted">{children}</div>
      )}
    </div>
  );
}

function PaymentForm({
  total,
  orderId,
  eventId,
  eventName,
}: {
  total: string;
  orderId: string;
  eventId: string;
  eventName: string;
}) {
  const hyper = useHyper();
  const widgets = useWidgets();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The hosted card form can take many seconds to appear (observed ~20 s in
  // the sandbox). Pay stays disabled, with a visible loading line, until the
  // widget reports it is ready, so a shopper cannot submit an empty form.
  const [widgetReady, setWidgetReady] = useState(false);
  const confirmationHref = `/confirmation/${encodeURIComponent(orderId)}`;

  // Wallet payment methods (PayPal, GPay, Apple Pay) render as their own
  // button inside the widget and handle their own click-to-redirect
  // internally — they don't go through handleSubmit/confirmPayment below
  // at all, so confirmParams.return_url never reaches them. Hyperswitch
  // docs call walletReturnUrl a mandatory option for these flows; without
  // it, a wallet button has nowhere valid to send the shopper back to.
  // Memoized so the widget doesn't see a new options object (and
  // potentially reset) on every unrelated re-render (isSubmitting, etc).
  //
  // Every return lands on the order's own confirmation page, keyed by our
  // order id in the PATH (never a provider id, and never a query parameter
  // that the provider's own appended return parameters could disturb).
  // Access there is checked against this browser's guest session.
  const returnUrl = `${window.location.origin}/confirmation/${encodeURIComponent(orderId)}`;
  const unifiedCheckoutOptions = useMemo(
    () => ({
      wallets: {
        walletReturnUrl: returnUrl,
      },
    }),
    [returnUrl]
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hyper || !widgets) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    // redirect: "if_required" keeps the shopper on this page unless the
    // connector needs a redirect (e.g. a 3DS challenge).
    //
    // The widget's promise has been seen to never settle when the provider's
    // edge rejects the confirm request. After CONFIRM_WATCHDOG_MS the shopper
    // is sent to the confirmation page anyway: it shows only the outcome the
    // server has verified with the provider, never an assumed one.
    let settled = false;
    const watchdog = setTimeout(() => {
      if (!settled) router.push(confirmationHref);
    }, CONFIRM_WATCHDOG_MS);
    let error: { message?: string } | undefined;
    try {
      ({ error } = await hyper.confirmPayment({
        elements: widgets,
        confirmParams: {
          return_url: returnUrl,
        },
        redirect: "if_required",
      }));
    } catch {
      error = {};
    } finally {
      settled = true;
      clearTimeout(watchdog);
    }

    if (error) {
      // An error can mean "fix the card details" or "the payment ended". Ask
      // the server for the verified order state: if the booking is no longer
      // payable, the confirmation page explains what happened.
      const status = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ status?: string }>) : null))
        .catch(() => null);
      if (status?.status && status.status !== "pending") {
        router.push(confirmationHref);
        return;
      }
      setIsSubmitting(false);
      setErrorMessage(friendlyPaymentError(error.message));
      return;
    }

    router.push(confirmationHref);
  };

  return (
    <form onSubmit={handleSubmit}>
      <SandboxCardHelp />
      {!widgetReady && (
        <div role="status" className="mb-4">
          <div aria-hidden className="space-y-3 motion-safe:animate-pulse">
            <div className="h-12 rounded-sm bg-ink-line/70" />
            <div className="h-11 rounded-sm bg-ink-line/50" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-11 rounded-sm bg-ink-line/50" />
              <div className="h-11 rounded-sm bg-ink-line/50" />
            </div>
          </div>
          <p className="mt-3 flex items-center gap-2 font-body text-sm text-text-muted">
            <span className="spinner" aria-hidden /> Loading the secure payment form from
            Hyperswitch — this can take a few seconds.
          </p>
        </div>
      )}
      <UnifiedCheckout
        id="unified-checkout"
        options={unifiedCheckoutOptions}
        onReady={() => setWidgetReady(true)}
      />
      <button
        type="submit"
        disabled={isSubmitting || !widgetReady}
        className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 bg-flame py-3 text-center font-display text-lg font-bold tracking-wide text-ink transition-[transform,filter] duration-150 hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:brightness-100"
      >
        {isSubmitting && <span className="spinner" aria-hidden />}
        {isSubmitting ? "PROCESSING…" : `PAY ${total}`}
      </button>

      {errorMessage && (
        <div className="mt-3 border border-flame-dim/50 bg-flame/10 p-3">
          <p className="font-mono text-xs font-bold text-flame">
            {errorMessage}
          </p>
          <p className="mt-1 font-body text-xs text-text-muted">
            Give it another try above with a different card, or{" "}
            <Link
              href={`/events/${eventId}`}
              className="text-text underline underline-offset-2"
            >
              head back to {eventName}
            </Link>
            . You haven&apos;t been charged.
          </p>
        </div>
      )}

      <p className="mt-3 text-center font-mono text-xs tracking-wide text-text-faint">
        PAYMENTS SECURED BY HYPERSWITCH
      </p>
    </form>
  );
}

export default function CheckoutPage() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-6 py-10 sm:py-16">
      <Suspense fallback={<StatusCard title="Loading…" tone="muted" showSpinner />}>
        <CheckoutContent />
      </Suspense>
    </main>
  );
}
