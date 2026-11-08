"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getEvent } from "@/lib/events";
import { formatCents, formatDateStamp, formatTime } from "@/lib/format";
import { posterColorClasses } from "@/lib/theme";
import { Icon } from "@/components/Icon";
import { BROWSE_ONLY_NOTE, ensureGuestSession, SAME_BROWSER_NOTE } from "@/lib/guest-client";
import type { OrderView } from "@/lib/types";

// Lists the orders owned by THIS browser's guest session (GET /api/orders).
// It replaces the old "type an order id" lookup: an order id is no longer a
// credential. Opening the page also renews the session's lifetime.

type State =
  | { kind: "loading" }
  | { kind: "ready"; orders: OrderView[] }
  | { kind: "no_session" }
  | { kind: "browse_only" }
  | { kind: "error" };

const STATUS_LABEL: Record<OrderView["status"], string> = {
  succeeded: "VALID FOR ENTRY",
  refunded: "REFUNDED",
  pending: "PAYMENT PENDING",
  failed: "PAYMENT DIDN'T GO THROUGH",
  expired: "HOLD EXPIRED",
};

export default function MyTicketsPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await ensureGuestSession();
      if (cancelled) return;
      if (session === "browse_only") return setState({ kind: "browse_only" });
      if (session !== "ok") return setState({ kind: "no_session" });
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
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12 sm:px-10 sm:py-16">
      <h1 className="font-display text-4xl font-black tracking-tight">MY TICKETS</h1>
      <p className="mt-2 max-w-[60ch] font-body text-sm text-text-muted">{SAME_BROWSER_NOTE}</p>

      <div className="mt-8">
        {state.kind === "loading" && (
          <div role="status" aria-label="Loading your tickets">
            <ul aria-hidden className="space-y-3 motion-safe:animate-pulse">
              {[0, 1].map((i) => (
                <li key={i} className="h-24 border border-ink-line bg-ink-raised" />
              ))}
            </ul>
          </div>
        )}

        {state.kind === "no_session" && (
          <p className="font-body text-sm text-text-muted">
            We couldn&apos;t start a ticket session in this browser. Check
            that cookies are allowed for this site, then reload.
          </p>
        )}

        {state.kind === "browse_only" && (
          <p className="font-body text-sm text-text-muted">{BROWSE_ONLY_NOTE}</p>
        )}

        {state.kind === "error" && (
          <p role="alert" className="font-body text-sm text-flame">
            Something went wrong loading your tickets — try again in a moment.
          </p>
        )}

        {state.kind === "ready" && state.orders.length === 0 && (
          <div className="border border-dashed border-ink-line p-6">
            <p className="font-display text-xl font-bold">No tickets in this browser yet</p>
            <p className="mt-1 font-body text-sm text-text-muted">
              Book a show and its ticket appears here. Tickets bought in another
              browser or on another device won&apos;t show up.
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex min-h-11 items-center gap-2 bg-flame px-4 font-display text-base font-bold tracking-wide text-ink transition-[filter] hover:brightness-110"
            >
              BROWSE SHOWS <Icon name="arrow-right" size={16} />
            </Link>
          </div>
        )}

        {state.kind === "ready" && state.orders.length > 0 && (
          <ul className="space-y-3">
            {state.orders.map((order) => {
              const event = getEvent(order.eventId);
              const live = order.status === "succeeded" || order.status === "pending";
              const stamp = event ? formatDateStamp(event.date, event.venueTimeZone) : null;
              const colors = event ? posterColorClasses[event.posterColor] : null;
              return (
                <li key={order.id}>
                  <Link
                    href={`/confirmation/${order.id}`}
                    className="group flex items-center gap-4 border border-ink-line bg-ink-raised p-4 transition-colors hover:border-text-muted"
                  >
                    {stamp && colors && (
                      <div className={`w-14 shrink-0 text-center font-mono leading-tight ${live ? "" : "opacity-60"}`}>
                        <div className={`text-xs ${colors.text}`}>{stamp.weekday}</div>
                        <div className="text-lg font-bold">{stamp.day}</div>
                        <div className="text-xs text-text-muted">{stamp.month}</div>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-xl font-extrabold tracking-tight">
                        {event?.name ?? "Event"}
                      </p>
                      {event && (
                        <p className="font-body text-sm text-text-muted">
                          {event.venue} · show {formatTime(event.date, event.venueTimeZone)}
                        </p>
                      )}
                      <p className="mt-1 font-mono text-xs text-text-muted">
                        {order.quantity} × {order.tierName} · {formatCents(order.amountCents)}
                      </p>
                      <p
                        className={`mt-2 font-mono text-xs font-bold tracking-wide ${
                          order.status === "succeeded" ? "text-acid" : "text-text-faint"
                        }`}
                      >
                        {STATUS_LABEL[order.status]}
                      </p>
                    </div>
                    <Icon
                      name="arrow-right"
                      className="shrink-0 text-text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-text"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
