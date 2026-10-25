"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { getEvent } from "@/lib/events";
import { formatCents, formatDateStamp, formatTime } from "@/lib/format";
import { SAME_BROWSER_NOTE } from "@/lib/guest-client";
import { posterColorClasses } from "@/lib/theme";
import type { OrderView } from "@/lib/types";

// The printed e-ticket for one of the guest's own orders. Display only:
// online cancellation and refunds are disabled until the refund phase adds
// authorization and duplicate-safe provider handling.
export function Ticket({ order }: { order: OrderView }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const refunded = order.status === "refunded";
  const event = getEvent(order.eventId);
  const colors = event ? posterColorClasses[event.posterColor] : null;
  const stamp = event ? formatDateStamp(event.date) : null;

  useEffect(() => {
    QRCode.toDataURL(order.id, {
      width: 220,
      margin: 0,
      color: { dark: "#1a1712", light: "#00000000" },
    }).then(setQrDataUrl);
  }, [order.id]);

  return (
    <div className="mx-auto min-w-0 max-w-sm">
      <div
        className={`ticket-print-in grain relative overflow-hidden border border-black/10 bg-paper text-paper-ink shadow-[0_20px_50px_-15px_rgba(0,0,0,0.6)] ${
          refunded ? "grayscale" : ""
        }`}
      >
        {/* edge notches */}
        <span className="absolute top-[168px] -left-3 h-6 w-6 rounded-full bg-ink" />
        <span className="absolute top-[168px] -right-3 h-6 w-6 rounded-full bg-ink" />

        <div className="p-6 pb-5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold tracking-widest text-paper-ink/50">
              CONTICX · E-TICKET
            </span>
            {colors && (
              <span className={`h-2.5 w-2.5 rounded-full ${colors.bg}`} />
            )}
          </div>

          {event ? (
            <>
              <h1 className="mt-3 font-display text-4xl leading-[0.95] font-black tracking-tight">
                {event.name}
              </h1>
              <p className="mt-1 font-body text-sm text-paper-ink/70">
                {event.artist}
              </p>
              {stamp && (
                <p className="mt-3 font-mono text-[11px] font-bold tracking-wide text-paper-ink/70">
                  {stamp.weekday} {stamp.month} {stamp.day} · DOORS{" "}
                  {formatTime(event.date)} · {event.venue.toUpperCase()}
                </p>
              )}
            </>
          ) : (
            <h1 className="mt-3 font-display text-3xl font-black">
              Your ticket
            </h1>
          )}

          <p className="mt-3 font-mono text-xs font-bold text-paper-ink/70">
            {order.quantity} × {order.tierName} —{" "}
            {refunded ? "REFUNDED" : formatCents(order.amountCents)}
          </p>
        </div>

        {/* perforation */}
        <div
          className="relative h-4 w-full"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, var(--color-ink) 0 5px, transparent 5.5px)",
            backgroundSize: "18px 100%",
            backgroundRepeat: "repeat-x",
            backgroundPosition: "center",
          }}
        />

        <div className="flex items-center gap-5 p-6 pt-5">
          <div className="shrink-0">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Ticket QR code"
                width={96}
                height={96}
                className="bg-paper"
              />
            ) : (
              <div className="h-24 w-24 animate-pulse bg-paper-dim" />
            )}
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[10px] tracking-widest text-paper-ink/50">
              ORDER
            </p>
            <p className="truncate font-mono text-sm font-bold">{order.id}</p>
            <p className="mt-3 font-mono text-[10px] tracking-widest text-paper-ink/50">
              STATUS
            </p>
            <p className="font-mono text-sm font-bold">
              {refunded ? "VOID — REFUNDED" : "VALID FOR ENTRY"}
            </p>
          </div>
        </div>

        {refunded && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-12 border-4 border-flame-dim px-4 py-1 mix-blend-multiply"
          >
            <span className="font-display text-3xl font-black tracking-widest text-flame-dim">
              REFUNDED
            </span>
          </div>
        )}
      </div>

      <div className="mt-6 text-center">
        {!refunded && (
          <p className="font-body text-xs text-text-faint">
            Online cancellation and refunds aren&apos;t available yet.
          </p>
        )}
        <p className="mt-2 font-body text-xs text-text-faint">{SAME_BROWSER_NOTE}</p>
        <div className="mt-4 flex justify-center gap-5">
          <Link
            href="/my-tickets"
            className="font-mono text-xs text-text underline underline-offset-4"
          >
            My tickets
          </Link>
          <Link
            href="/"
            className="font-mono text-xs text-text underline underline-offset-4"
          >
            ← Browse other shows
          </Link>
        </div>
      </div>
    </div>
  );
}
