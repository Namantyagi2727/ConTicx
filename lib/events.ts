import type { EventRecord } from "./types";

// Hardcoded event catalog for the prototype — no CMS or database.
export const events: EventRecord[] = [
  {
    id: "neon-nights",
    name: "Neon Nights Festival",
    artist: "The Voltage Collective",
    date: "2026-09-12T19:00:00-04:00",
    doorsMinutesBeforeShow: 60,
    venue: "Brooklyn Steel",
    venueAddress: "319 Frost St, Brooklyn, NY 11222",
    ageRestriction: "18+",
    genres: ["synth-pop", "indie electronic"],
    supportActs: ["Cassette Youth", "Nightbloom"],
    description:
      "The Voltage Collective bring their arena-built synth rig into a room a tenth the size — full LED wall, no seats, bass you feel in the floor. Second stop of a three-city warm-up before the record drops in October.",
    posterColor: "flame",
    tiers: [
      {
        name: "GA",
        priceCents: 4500,
        totalInventory: 50,
        perk: "General floor, standing room",
      },
      {
        name: "VIP",
        priceCents: 12000,
        totalInventory: 10,
        perk: "Early entry, side platform, merch item included",
      },
    ],
  },
  {
    id: "indie-echoes",
    name: "Indie Echoes",
    artist: "Maple & Static",
    date: "2026-09-20T20:00:00-04:00",
    doorsMinutesBeforeShow: 45,
    venue: "Warsaw",
    venueAddress: "261 Driggs Ave, Brooklyn, NY 11222",
    ageRestriction: "All ages",
    genres: ["dream pop", "shoegaze"],
    supportActs: ["Low Tide Radio"],
    description:
      "Maple & Static's reverb-heavy live show barely resembles the studio records — longer, louder, more pedal changes than a band twice their size. One night only before they leave for a European support tour.",
    posterColor: "violet",
    tiers: [
      {
        name: "GA",
        priceCents: 3500,
        totalInventory: 50,
        perk: "General floor, standing room",
      },
      {
        name: "VIP",
        priceCents: 9000,
        totalInventory: 10,
        perk: "Early entry, reserved balcony seat",
      },
    ],
  },
  {
    id: "midnight-parade",
    name: "Midnight Parade",
    artist: "Coral Ruins",
    date: "2026-10-03T19:30:00-04:00",
    doorsMinutesBeforeShow: 60,
    venue: "Elsewhere",
    venueAddress: "599 Johnson Ave, Brooklyn, NY 11237",
    ageRestriction: "21+",
    genres: ["post-punk", "art rock"],
    supportActs: ["Vantablack", "The Municipal"],
    description:
      "Coral Ruins close out the fall tour where they opened it eight months ago — full band, no truncated setlist, a surprise opener nobody's naming yet. Last Brooklyn date until next year.",
    posterColor: "acid",
    tiers: [
      {
        name: "GA",
        priceCents: 4000,
        totalInventory: 50,
        perk: "General floor, standing room",
      },
      {
        name: "VIP",
        priceCents: 10000,
        totalInventory: 10,
        perk: "Early entry, upstairs bar access, merch item included",
      },
    ],
  },
];

export function getEvent(id: string): EventRecord | undefined {
  return events.find((event) => event.id === id);
}
