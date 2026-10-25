import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/events";
import { getRecentDemand, getRemainingInventory } from "@/lib/store";
import { bookingEnabled } from "@/lib/app-mode";
import { DEMAND_DISPLAY_THRESHOLD } from "@/lib/constants";
import { formatDateStamp, formatDoorsTime, formatTime } from "@/lib/format";
import { posterColorClasses } from "@/lib/theme";
import { TierPicker } from "@/components/TierPicker";
import { PosterArt } from "@/components/PosterArt";
import type { TierAvailability } from "@/lib/types";

// Remaining inventory comes from an in-memory store that changes as
// orders come in, so this page can't be statically prerendered — it
// needs to recompute availability on every request.
export const dynamic = "force-dynamic";

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = getEvent(id);
  if (!event) notFound();

  // In the browse-only demo the page never reads inventory: that read runs
  // lazy hold expiry (which can call the payment provider and write) and
  // seeds counters. The catalog's capacities stand in, and no availability
  // is shown.
  const canBook = bookingEnabled();
  const [availability, recentDemand] = canBook
    ? await Promise.all([
        Promise.all(
          event.tiers.map(
            async (tier): Promise<TierAvailability> => ({
              ...tier,
              remaining: await getRemainingInventory(event.id, tier.name, tier.totalInventory),
            })
          )
        ),
        getRecentDemand(event.id),
      ])
    : [event.tiers.map((tier): TierAvailability => ({ ...tier, remaining: tier.totalInventory })), 0];

  const stamp = formatDateStamp(event.date);
  const colors = posterColorClasses[event.posterColor];

  return (
    <main className="flex-1">
      <div className="border-b border-ink-line px-6 py-5 sm:px-10">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/"
            className="font-mono text-xs text-text-faint transition-colors hover:text-text"
          >
            ← ALL SHOWS
          </Link>
        </div>
      </div>

      {/* Poster hero */}
      <div className={`relative overflow-hidden border-b border-ink-line bg-ink ${colors.text}`}>
        <PosterArt seed={event.id} className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-0 bg-gradient-to-b from-ink/75 via-ink/85 to-ink" />
        <div className="relative mx-auto max-w-3xl px-6 py-14 sm:px-10 sm:py-20">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold text-ink ${colors.bg}`}
            >
              {stamp.weekday} {stamp.month} {stamp.day}
            </span>
            <span className="rounded-full border border-ink-line bg-ink px-3 py-1 font-mono text-[11px] text-text-muted">
              {event.ageRestriction}
            </span>
            {event.genres.map((genre) => (
              <span
                key={genre}
                className="rounded-full border border-ink-line bg-ink px-3 py-1 font-mono text-[11px] text-text-muted"
              >
                {genre}
              </span>
            ))}
          </div>

          <h1 className="mt-5 font-display text-6xl leading-[0.9] font-black tracking-tight text-text drop-shadow-[0_2px_16px_rgba(0,0,0,0.8)] sm:text-7xl">
            {event.name}
          </h1>
          <p className="mt-3 font-display text-2xl font-bold text-text-muted">
            {event.artist}
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-10 sm:px-10">
        {/* Key facts strip */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-ink-line bg-ink-line sm:grid-cols-4">
          {[
            { label: "DOORS", value: formatDoorsTime(event.date, event.doorsMinutesBeforeShow) },
            { label: "SHOW", value: formatTime(event.date) },
            { label: "VENUE", value: event.venue },
            { label: "AGE", value: event.ageRestriction },
          ].map((fact) => (
            <div key={fact.label} className="bg-ink-raised px-4 py-3">
              <p className="font-mono text-[10px] text-text-faint">{fact.label}</p>
              <p className="mt-1 font-mono text-sm font-bold text-text">{fact.value}</p>
            </div>
          ))}
        </div>

        {/* About */}
        <section className="mt-10">
          <h2 className="font-display text-sm font-bold tracking-[0.15em] text-text-faint">
            ABOUT THIS SHOW
          </h2>
          <p className="mt-3 max-w-xl font-body text-base leading-relaxed text-text-muted">
            {event.description}
          </p>

          {event.supportActs.length > 0 && (
            <p className="mt-4 font-mono text-xs text-text-faint">
              WITH{" "}
              <span className="text-text-muted">
                {event.supportActs.join(" · ")}
              </span>
            </p>
          )}

          <p className="mt-6 font-mono text-xs text-text-faint">
            {event.venue.toUpperCase()} · {event.venueAddress}
          </p>
        </section>

        {/* Tickets */}
        <section className="mt-12">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-display text-sm font-bold tracking-[0.15em] text-text-faint">
              PICK YOUR TICKET
            </h2>
            {recentDemand >= DEMAND_DISPLAY_THRESHOLD && (
              <span className="rounded-full bg-acid px-2 py-0.5 font-mono text-[11px] font-bold text-ink">
                {recentDemand} PEOPLE GRABBED TICKETS IN THE LAST HOUR
              </span>
            )}
          </div>
          <TierPicker event={event} availability={availability} bookingEnabled={canBook} />
        </section>
      </div>
    </main>
  );
}
