import Link from "next/link";
import { SAME_BROWSER_NOTE } from "@/lib/guest-client";

// Old confirmation links (Phase 1B.4 and earlier) identified a ticket by
// its provider payment id in the query string. Those ids are no longer
// accepted as a way to open a ticket, so this page performs no lookup at
// all — it ignores its query parameters and points to My Tickets, which
// lists the orders this browser owns. Checkout now returns to
// /confirmation/[orderId].
export default function LegacyConfirmationPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="mx-auto max-w-sm border border-ink-line bg-ink-raised p-6 text-center">
        <h1 className="mb-2 font-display text-xl font-bold text-text">
          This link has moved
        </h1>
        <p className="font-body text-sm text-text-muted">
          Confirmation links like this one aren&apos;t used anymore. If you
          bought tickets in this browser, they&apos;re in My Tickets.
        </p>
        <p className="mt-3 font-body text-xs text-text-faint">{SAME_BROWSER_NOTE}</p>
        <div className="mt-4 flex justify-center gap-5">
          <Link href="/my-tickets" className="font-mono text-xs text-text underline underline-offset-4">
            My tickets
          </Link>
          <Link href="/" className="font-mono text-xs text-text underline underline-offset-4">
            ← Browse shows
          </Link>
        </div>
      </div>
    </main>
  );
}
