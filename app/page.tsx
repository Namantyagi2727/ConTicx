import Link from "next/link";
import { events } from "@/lib/events";
import { formatCents, formatEventDate } from "@/lib/format";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold">ConTicx</h1>
      <p className="mt-2 text-gray-600">Concert tickets, booked in sandbox.</p>

      <div className="mt-8 space-y-4">
        {events.map((event) => {
          const startingPrice = Math.min(...event.tiers.map((t) => t.priceCents));
          return (
            <Link
              key={event.id}
              href={`/events/${event.id}`}
              className="block rounded-lg border border-gray-200 p-5 transition-colors hover:border-gray-400"
            >
              <p className="text-lg font-medium">{event.name}</p>
              <p className="text-gray-600">{event.artist}</p>
              <p className="mt-1 text-sm text-gray-500">
                {formatEventDate(event.date)} · {event.venue}
              </p>
              <p className="mt-2 text-sm font-medium">
                From {formatCents(startingPrice)}
              </p>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
