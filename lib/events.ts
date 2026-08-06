import type { EventRecord } from "./types";

// Hardcoded event catalog for the prototype — no CMS or database.
export const events: EventRecord[] = [
  {
    id: "neon-nights",
    name: "Neon Nights Festival",
    artist: "The Voltage Collective",
    date: "2026-09-12T19:00:00-04:00",
    venue: "Brooklyn Steel, NYC",
    description:
      "A night of synth-driven indie pop headlined by The Voltage Collective, with two support acts.",
    tiers: [
      { name: "GA", priceCents: 4500, totalInventory: 50 },
      { name: "VIP", priceCents: 12000, totalInventory: 10 },
    ],
  },
  {
    id: "indie-echoes",
    name: "Indie Echoes",
    artist: "Maple & Static",
    date: "2026-09-20T20:00:00-04:00",
    venue: "Warsaw, Brooklyn",
    description:
      "Maple & Static bring their reverb-heavy live show to Warsaw for one night only.",
    tiers: [
      { name: "GA", priceCents: 3500, totalInventory: 50 },
      { name: "VIP", priceCents: 9000, totalInventory: 10 },
    ],
  },
  {
    id: "midnight-parade",
    name: "Midnight Parade",
    artist: "Coral Ruins",
    date: "2026-10-03T19:30:00-04:00",
    venue: "Elsewhere, Brooklyn",
    description:
      "Coral Ruins close out their fall tour with a full-band set and a surprise opener.",
    tiers: [
      { name: "GA", priceCents: 4000, totalInventory: 50 },
      { name: "VIP", priceCents: 10000, totalInventory: 10 },
    ],
  },
];

export function getEvent(id: string): EventRecord | undefined {
  return events.find((event) => event.id === id);
}
