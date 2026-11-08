import Link from "next/link";
import { Icon } from "@/components/Icon";
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
        <p className="mt-3 font-body text-sm text-text-faint">{SAME_BROWSER_NOTE}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-x-6">
          <Link href="/my-tickets" className="inline-flex min-h-11 items-center gap-1.5 font-body text-sm text-text underline underline-offset-4">
            <Icon name="ticket" size={16} /> My tickets
          </Link>
          <Link href="/" className="inline-flex min-h-11 items-center gap-1.5 font-body text-sm text-text underline underline-offset-4">
            <Icon name="arrow-left" size={16} /> Browse shows
          </Link>
        </div>
      </div>
    </main>
  );
}
