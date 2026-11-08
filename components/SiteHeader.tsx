"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

// The same header on every page, so home and My Tickets are always one tap
// away — including from deep in checkout or on a ticket.
export function SiteHeader() {
  const pathname = usePathname();
  const onTickets = pathname === "/my-tickets";

  return (
    <header className="border-b border-ink-line px-4 sm:px-10">
      <nav
        aria-label="Site"
        className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4"
      >
        <Link
          href="/"
          className="-ml-2 inline-flex min-h-11 items-center px-2 font-display text-2xl font-extrabold tracking-tight"
        >
          CONTICX
        </Link>
        <Link
          href="/my-tickets"
          aria-current={onTickets ? "page" : undefined}
          className={`-mr-2 inline-flex min-h-11 items-center gap-2 px-2 font-body text-sm font-medium transition-colors ${
            onTickets ? "text-text underline decoration-flame decoration-2 underline-offset-8" : "text-text-muted hover:text-text"
          }`}
        >
          <Icon name="ticket" />
          My tickets
        </Link>
      </nav>
    </header>
  );
}
