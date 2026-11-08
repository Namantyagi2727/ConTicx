import Link from "next/link";
import { events } from "@/lib/events";
import { formatCents, formatDateStamp } from "@/lib/format";
import { posterColorClasses } from "@/lib/theme";
import { PosterArt } from "@/components/PosterArt";
import { appMode } from "@/lib/app-mode";
import { Icon } from "@/components/Icon";

// Tailwind's default rotate scale only covers a few steps (1, 2, 3, 6,
// 12...) — "-rotate-0.5" isn't one of them and gets silently dropped,
// so these need explicit arbitrary-value degrees to actually apply.
const CARD_ROTATIONS = ["rotate-[-1.75deg]", "rotate-[1.5deg]", "rotate-[-1deg]"];

// Read at request time so the page's description of the demo always matches
// what the server actually enforces (see lib/app-mode.ts).
export const dynamic = "force-dynamic";

export default function Home() {
  const browseOnly = appMode() === "browse-only";
  return (
    <main className="flex-1">
      <section className="mx-auto max-w-5xl px-6 pt-14 pb-12 sm:px-10 sm:pt-20">
        <h1 className="font-display text-6xl leading-[0.92] font-black tracking-tight sm:text-8xl">
          SMALL ROOMS.
          <br />
          LOUD NIGHTS.
        </h1>
        <p className="mt-6 max-w-md font-body text-base text-text-muted">
          Three shows, three rooms, this fall in Brooklyn. Tickets held for
          ten minutes at checkout — test payments, real urgency.
        </p>
        <p className="mt-6 inline-flex max-w-md items-start gap-2.5 rounded-sm border border-ink-line bg-ink-raised px-3 py-2.5 font-body text-sm text-text-muted">
          <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-acid" />
          {browseOnly ? (
            <span>
              <strong className="font-semibold text-text">Browse-only demo.</strong> Booking
              and payments are switched off here; the complete checkout runs
              locally against a simulated payment provider (see the project
              README).
            </span>
          ) : (
            <span>
              <strong className="font-semibold text-text">Sandbox demo.</strong> Book a
              seat and pay with a Hyperswitch test card — no real money moves,
              and the shows and tickets are fictional. Checkout shows the
              card to use.
            </span>
          )}
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24 sm:px-10">
        <div className="mb-8 flex items-center gap-3">
          <h2 className="font-display text-2xl font-bold tracking-wide">
            UPCOMING
          </h2>
          <span className="h-px flex-1 bg-ink-line" />
          <span className="font-mono text-xs text-text-faint">
            {events.length} shows
          </span>
        </div>

        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event, i) => {
            const startingPrice = Math.min(...event.tiers.map((t) => t.priceCents));
            const stamp = formatDateStamp(event.date, event.venueTimeZone);
            const colors = posterColorClasses[event.posterColor];
            const rotation = CARD_ROTATIONS[i % CARD_ROTATIONS.length];

            return (
              <Link
                key={event.id}
                href={`/events/${event.id}`}
                className={`group relative block ${rotation} transition-transform duration-200 ease-out hover:rotate-0 focus-visible:rotate-0 motion-reduce:rotate-0`}
              >
                <span
                  aria-hidden
                  className={`absolute -top-2 left-6 z-10 h-4 w-4 rounded-full border-2 border-ink ${colors.bg}`}
                />
                <div className="grain relative overflow-hidden border border-ink-line bg-ink-raised">
                  <div
                    className={`relative h-32 overflow-hidden bg-ink ${colors.text} border-b border-ink-line`}
                  >
                    <PosterArt
                      seed={event.id}
                      className="absolute inset-0 h-full w-full"
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent to-ink-raised" />
                  </div>

                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-mono text-xs leading-tight text-text-muted">
                        <div className={colors.text}>{stamp.weekday}</div>
                        <div className="text-lg font-bold text-text">
                          {stamp.month} {stamp.day}
                        </div>
                      </div>
                      <span className="rounded-full border border-ink-line px-2 py-0.5 font-mono text-xs text-text-muted">
                        {event.ageRestriction}
                      </span>
                    </div>

                    <h3 className="mt-4 font-display text-3xl leading-[0.95] font-extrabold tracking-tight">
                      {event.name}
                    </h3>
                    <p className="mt-1 font-body text-sm text-text-muted">
                      {event.artist}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {event.genres.map((genre) => (
                        <span
                          key={genre}
                          className="rounded-full bg-ink px-2 py-0.5 font-body text-xs text-text-muted"
                        >
                          {genre}
                        </span>
                      ))}
                    </div>

                    <div className="mt-5 flex items-center justify-between border-t border-dashed border-ink-line pt-4">
                      <div>
                        <p className="font-body text-xs text-text-muted">
                          {event.venue}
                        </p>
                        <p className="font-mono text-sm font-bold">
                          FROM {formatCents(startingPrice)}
                        </p>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 font-display text-sm font-bold tracking-wide ${colors.text} transition-transform group-hover:translate-x-1`}
                      >
                        TICKETS <Icon name="arrow-right" size={16} />
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <footer className="border-t border-ink-line px-6 py-12 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-8 sm:grid-cols-3">
            <div>
              <p className="font-display text-sm font-bold tracking-wide">
                HOW IT WORKS
              </p>
              <p className="mt-2 font-body text-sm leading-relaxed text-text-muted">
                Pick a tier and your seats are held for ten minutes while
                you pay in the checkout widget. Reloading checkout picks up
                the same booking instead of starting another.
              </p>
            </div>
            <div>
              <p className="font-display text-sm font-bold tracking-wide">
                TICKETS
              </p>
              <p className="mt-2 font-body text-sm leading-relaxed text-text-muted">
                Tickets live in the browser you booked with and can be added
                to your calendar. Online cancellation and refunds aren&apos;t
                available in this demo.
              </p>
            </div>
            <div>
              <p className="font-display text-sm font-bold tracking-wide">
                {browseOnly ? "DEMO NOTICE" : "TEST NOTICE"}
              </p>
              <p className="mt-2 font-body text-sm leading-relaxed text-text-muted">
                {browseOnly
                  ? "Browse-only: nothing can be booked or paid for here, and no payment provider is contacted."
                  : "Hyperswitch sandbox: test cards only, no real charges. The shows and tickets are fictional."}
              </p>
            </div>
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-ink-line pt-6">
            <p className="font-mono text-xs text-text-faint">
              CONTICX · A PORTFOLIO PROJECT · FICTIONAL SHOWS
            </p>
            <Link
              href="/my-tickets"
              className="inline-flex min-h-11 items-center gap-1.5 font-body text-sm text-text underline underline-offset-4"
            >
              Your tickets in this browser <Icon name="arrow-right" size={16} />
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
