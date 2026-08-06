import Link from "next/link";
import { events } from "@/lib/events";
import { formatCents, formatDateStamp } from "@/lib/format";
import { posterColorClasses } from "@/lib/theme";

// Tailwind's default rotate scale only covers a few steps (1, 2, 3, 6,
// 12...) — "-rotate-0.5" isn't one of them and gets silently dropped,
// so these need explicit arbitrary-value degrees to actually apply.
const CARD_ROTATIONS = ["rotate-[-1.75deg]", "rotate-[1.5deg]", "rotate-[-1deg]"];

export default function Home() {
  return (
    <main className="flex-1">
      <header className="border-b border-ink-line px-6 py-5 sm:px-10">
        <div className="mx-auto flex max-w-5xl items-baseline justify-between">
          <span className="font-display text-2xl font-extrabold tracking-tight">
            CONTICX
          </span>
          <span className="font-mono text-xs text-text-faint">
            BROOKLYN · SANDBOX ISSUE
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 pt-16 pb-12 sm:px-10 sm:pt-24">
        <p className="font-mono text-xs tracking-[0.2em] text-flame">
          NOW BOOKING
        </p>
        <h1 className="mt-3 font-display text-6xl leading-[0.92] font-black tracking-tight sm:text-8xl">
          SMALL ROOMS.
          <br />
          LOUD NIGHTS.
        </h1>
        <p className="mt-6 max-w-md font-body text-base text-text-muted">
          Three shows, three rooms, this fall in Brooklyn. Tickets held for
          ten minutes at checkout — sandbox payments, real urgency.
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24 sm:px-10">
        <div className="mb-8 flex items-center gap-3">
          <h2 className="font-display text-xl font-bold tracking-wide">
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
            const stamp = formatDateStamp(event.date);
            const colors = posterColorClasses[event.posterColor];
            const rotation = CARD_ROTATIONS[i % CARD_ROTATIONS.length];

            return (
              <Link
                key={event.id}
                href={`/events/${event.id}`}
                className={`group relative block ${rotation} transition-transform duration-300 hover:rotate-0 focus-visible:rotate-0`}
              >
                <span
                  aria-hidden
                  className={`absolute -top-2 left-6 z-10 h-4 w-4 rounded-full border-2 border-ink ${colors.bg}`}
                />
                <div className="grain relative overflow-hidden border border-ink-line bg-ink-raised">
                  <div
                    className={`halftone relative h-28 ${colors.text} border-b border-ink-line`}
                  >
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
                      <span className="rounded-full border border-ink-line px-2 py-0.5 font-mono text-[10px] text-text-faint">
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
                          className="rounded-full bg-ink px-2 py-0.5 font-mono text-[10px] text-text-faint"
                        >
                          {genre}
                        </span>
                      ))}
                    </div>

                    <div className="mt-5 flex items-center justify-between border-t border-dashed border-ink-line pt-4">
                      <div>
                        <p className="font-mono text-[10px] text-text-faint">
                          {event.venue}
                        </p>
                        <p className="font-mono text-sm font-bold">
                          FROM {formatCents(startingPrice)}
                        </p>
                      </div>
                      <span
                        className={`font-display text-sm font-bold tracking-wide ${colors.text} transition-transform group-hover:translate-x-1`}
                      >
                        VIEW →
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
