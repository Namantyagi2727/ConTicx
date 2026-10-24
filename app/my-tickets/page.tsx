"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getEvent } from "@/lib/events";
import { formatCents } from "@/lib/format";
import { ensureGuestSession, SAME_BROWSER_NOTE } from "@/lib/guest-client";
import type { OrderView } from "@/lib/types";

// Lists the orders owned by THIS browser's guest session (GET /api/orders).
// It replaces the old "type an order id" lookup: an order id is no longer a
// credential. Opening the page also renews the session's lifetime.

type State =
  | { kind: "loading" }
  | { kind: "ready"; orders: OrderView[] }
  | { kind: "no_session" }
  | { kind: "error" };

const STATUS_LABEL: Record<OrderView["status"], string> = {
  succeeded: "VALID FOR ENTRY",
  refunded: "REFUNDED",
  pending: "CONFIRMING PAYMENT",
  failed: "PAYMENT DIDN'T GO THROUGH",
  expired: "HOLD EXPIRED",
};

export default function MyTicketsPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await ensureGuestSession();
      if (cancelled) return;
      if (!ok) return setState({ kind: "no_session" });
      try {
        const res = await fetch("/api/orders", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) return setState({ kind: "no_session" });
        if (!res.ok) return setState({ kind: "error" });
        const data: { orders: OrderView[] } = await res.json();
        if (!cancelled) setState({ kind: "ready", orders: data.orders });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <p className="font-mono text-xs tracking-[0.2em] text-flame">IN THIS BROWSER</p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">MY TICKETS</h1>
        <p className="mt-2 font-body text-sm text-text-muted">{SAME_BROWSER_NOTE}</p>

        <div className="mt-6">
          {state.kind === "loading" && (
            <p className="flex items-center gap-2 font-body text-sm text-text-muted">
              <span className="spinner" aria-hidden /> Loading your tickets…
            </p>
          )}

          {state.kind === "no_session" && (
            <p className="font-body text-sm text-text-muted">
              We couldn&apos;t start a ticket session in this browser. Check
              that cookies are allowed for this site, then reload.
            </p>
          )}

          {state.kind === "error" && (
            <p className="font-mono text-xs text-flame">
              Something went wrong loading your tickets — try again in a moment.
            </p>
          )}

          {state.kind === "ready" && state.orders.length === 0 && (
            <p className="font-body text-sm text-text-muted">
              No tickets in this browser yet. Tickets bought in another
              browser or on another device won&apos;t appear here.
            </p>
          )}

          {state.kind === "ready" && state.orders.length > 0 && (
            <ul className="space-y-3">
              {state.orders.map((order) => {
                const event = getEvent(order.eventId);
                const live = order.status === "succeeded" || order.status === "pending";
                return (
                  <li key={order.id}>
                    <Link
                      href={`/confirmation/${order.id}`}
                      className={`block border border-ink-line bg-ink-raised p-4 transition-colors hover:border-flame ${
                        live ? "" : "opacity-60"
                      }`}
                    >
                      <p className="font-display text-lg font-extrabold tracking-tight">
                        {event?.name ?? "Event"}
                      </p>
                      <p className="mt-1 font-mono text-xs text-text-muted">
                        {order.quantity} × {order.tierName} · {formatCents(order.amountCents)}
                      </p>
                      <p
                        className={`mt-2 font-mono text-[11px] font-bold tracking-wide ${
                          order.status === "succeeded" ? "text-acid" : "text-text-faint"
                        }`}
                      >
                        {STATUS_LABEL[order.status]}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Link
          href="/"
          className="mt-6 inline-block font-mono text-xs text-text-faint underline underline-offset-4"
        >
          ← Back to all shows
        </Link>
      </div>
    </main>
  );
}
