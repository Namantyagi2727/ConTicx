import { notFound } from "next/navigation";
import { getEvent } from "@/lib/events";
import { getRemainingInventory } from "@/lib/store";
import { formatEventDate } from "@/lib/format";
import { TierPicker } from "@/components/TierPicker";
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

  const availability: TierAvailability[] = event.tiers.map((tier) => ({
    ...tier,
    remaining: getRemainingInventory(event.id, tier.name, tier.totalInventory),
  }));

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">{event.name}</h1>
      <p className="text-gray-600">{event.artist}</p>
      <p className="mt-1 text-sm text-gray-500">
        {formatEventDate(event.date)} · {event.venue}
      </p>
      <p className="mt-4">{event.description}</p>

      <TierPicker event={event} availability={availability} />
    </main>
  );
}
