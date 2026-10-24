"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Ticket } from "@/components/Ticket";
import { getEvent } from "@/lib/events";
import { SAME_BROWSER_NOTE } from "@/lib/guest-client";
import type { OrderView } from "@/lib/types";

// Where checkout — and every provider redirect (3DS, wallets) — returns. The
// page knows only our order id, from the path. Its status comes from
// GET /api/orders/[id]/status, which answers only to the browser that owns
// the order and refreshes a pending payment from the provider server-side.
// There is no fallback to payment metadata: an order this browser cannot
// access is shown as unavailable, never reconstructed.

type Lookup =
  | { kind: "loading" }
  | { kind: "found"; order: OrderView; polling: boolean }
  | { kind: "no_session" }
  | { kind: "not_found" }
  | { kind: "error" };

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 10;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ConfirmationContent({ orderId }: { orderId: string }) {
  const [lookup, setLookup] = useState<Lookup>({ kind: "loading" });

  useEffect(() => {
    // Per-run flag (not a shared ref): React Strict Mode can mount, clean
    // up, and mount again before the async work below resolves.
    let cancelled = false;

    async function run() {
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        let res: Response;
        try {
          res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
            cache: "no-store",
          });
        } catch {
          if (!cancelled) setLookup({ kind: "error" });
          return;
        }
        if (cancelled) return;

        if (res.status === 401) return setLookup({ kind: "no_session" });
        if (res.status === 404) return setLookup({ kind: "not_found" });
        if (!res.ok) return setLookup({ kind: "error" });

        const order: OrderView = await res.json();
        if (cancelled) return;
        const pending = order.status === "pending";
        setLookup({ kind: "found", order, polling: pending });
        if (!pending) return;
        await sleep(POLL_INTERVAL_MS);
        if (cancelled) return;
      }
      // Still pending after the last attempt: stop polling, keep the message.
      setLookup((prev) => (prev.kind === "found" ? { ...prev, polling: false } : prev));
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (lookup.kind === "loading") {
    return <StatusLine showSpinner>Checking your order…</StatusLine>;
  }

  if (lookup.kind === "no_session") {
    return (
      <StatusLine title="Open this in the browser you booked with">
        We couldn&apos;t find a ticket session in this browser. Tickets can
        only be opened in the same browser they were bought in — if you
        cleared your browser data, access to them has been removed.
        <BackLinks />
      </StatusLine>
    );
  }

  if (lookup.kind === "not_found") {
    return (
      <StatusLine title="This order isn't available">
        There&apos;s no order with that link in this browser. If you bought
        tickets here, you&apos;ll find them under My Tickets.
        <BackLinks />
      </StatusLine>
    );
  }

  if (lookup.kind === "error") {
    return (
      <StatusLine title="We couldn't check your order">
        Something went wrong reaching our servers. Refresh this page in a
        moment — nothing about your order has changed.
        <BackLinks />
      </StatusLine>
    );
  }

  const { order, polling } = lookup;

  if (order.status === "succeeded" || order.status === "refunded") {
    return <Ticket order={order} />;
  }

  if (order.status === "pending") {
    return (
      <StatusLine showSpinner={polling}>
        Still confirming your payment — this usually only takes a few
        seconds. If it takes longer, check My Tickets in this browser
        shortly.
        <span className="mt-3 block font-body text-xs text-text-faint">
          {SAME_BROWSER_NOTE}
        </span>
      </StatusLine>
    );
  }

  // failed | expired
  const event = getEvent(order.eventId);
  return (
    <StatusLine title="That payment didn't go through">
      Nothing was charged.
      {event && (
        <Link
          href={`/events/${event.id}`}
          className="mt-4 inline-block bg-flame px-4 py-2 font-display text-sm font-bold tracking-wide text-ink no-underline"
        >
          TRY AGAIN — {event.name.toUpperCase()}
        </Link>
      )}
    </StatusLine>
  );
}

function BackLinks() {
  return (
    <span className="mt-4 flex justify-center gap-5">
      <Link href="/my-tickets" className="font-mono text-xs text-text underline underline-offset-4">
        My tickets
      </Link>
      <Link href="/" className="font-mono text-xs text-text underline underline-offset-4">
        ← Browse shows
      </Link>
    </span>
  );
}

function StatusLine({
  title,
  children,
  showSpinner,
}: {
  title?: string;
  children: React.ReactNode;
  showSpinner?: boolean;
}) {
  return (
    <div className="mx-auto max-w-sm border border-ink-line bg-ink-raised p-6 text-center">
      {showSpinner && (
        <span className="spinner mb-2 inline-block text-text-muted" aria-hidden />
      )}
      {title && (
        <h1 className="mb-2 font-display text-xl font-bold text-text">{title}</h1>
      )}
      <div className="font-body text-sm text-text-muted">{children}</div>
    </div>
  );
}

export default function ConfirmationPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = typeof params.orderId === "string" ? params.orderId : "";
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <ConfirmationContent orderId={orderId} />
    </main>
  );
}
