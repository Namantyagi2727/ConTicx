"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Order } from "@/lib/types";

export default function MyTicketsPage() {
  const router = useRouter();
  const [orderId, setOrderId] = useState("");
  const [isLooking, setIsLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = orderId.trim();
    if (!trimmed) return;

    setIsLooking(true);
    setError(null);

    const res = await fetch(`/api/orders/${encodeURIComponent(trimmed)}`);

    if (res.status === 404) {
      setIsLooking(false);
      setError(
        "We couldn't find an order with that ID — double check it and try again."
      );
      return;
    }

    if (!res.ok) {
      setIsLooking(false);
      setError("Something went wrong looking that up — try again in a moment.");
      return;
    }

    const order: Order = await res.json();

    if (!order.paymentId) {
      setIsLooking(false);
      setError("That order never made it to payment, so there's no ticket for it.");
      return;
    }

    // Confirmation page already knows how to render a ticket from a
    // payment id — reuse it entirely instead of duplicating the ticket
    // display here.
    router.push(`/confirmation?payment_id=${order.paymentId}`);
  };

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <p className="font-mono text-xs tracking-[0.2em] text-flame">
          LOST YOUR TAB?
        </p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">
          FIND YOUR TICKET
        </h1>
        <p className="mt-2 font-body text-sm text-text-muted">
          Enter the order ID printed on your ticket and we&apos;ll pull it
          back up.
        </p>

        <form onSubmit={handleSubmit} className="mt-6">
          <label
            htmlFor="orderId"
            className="font-mono text-[11px] tracking-wide text-text-faint"
          >
            ORDER ID
          </label>
          <input
            id="orderId"
            type="text"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="e.g. 7c92733d-0f50-445d-98b0-0da22464ce1a"
            className="mt-2 w-full border border-ink-line bg-ink-raised px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-flame focus:outline-none"
          />

          <button
            type="submit"
            disabled={isLooking || !orderId.trim()}
            className="mt-4 flex w-full items-center justify-center gap-2 bg-flame py-3 text-center font-display text-lg font-bold tracking-wide text-ink transition-transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50"
          >
            {isLooking && <span className="spinner" aria-hidden />}
            {isLooking ? "LOOKING…" : "FIND TICKET"}
          </button>
        </form>

        {error && (
          <p className="mt-3 font-mono text-xs text-flame">{error}</p>
        )}

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
