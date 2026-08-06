export type TierName = "GA" | "VIP";

export interface TicketTier {
  name: TierName;
  priceCents: number;
  totalInventory: number;
  perk: string; // short line on what this tier includes, shown on the tier card
}

export type PosterColor = "flame" | "acid" | "violet";

export interface EventRecord {
  id: string;
  name: string;
  artist: string;
  date: string; // ISO 8601 — show start time
  doorsMinutesBeforeShow: number;
  venue: string;
  venueAddress: string;
  ageRestriction: string;
  genres: string[];
  supportActs: string[];
  description: string;
  posterColor: PosterColor;
  tiers: TicketTier[];
}

export interface TierAvailability extends TicketTier {
  remaining: number;
}

export type OrderStatus = "pending" | "succeeded" | "failed" | "expired" | "refunded";

export interface Order {
  id: string;
  eventId: string;
  tierName: TierName;
  quantity: number;
  unitPriceCents: number;
  feeCents: number; // server-computed service fee, already folded into amountCents
  amountCents: number; // total charged: (unitPriceCents × quantity) + feeCents
  currency: string;
  status: OrderStatus;
  paymentId?: string;
  holdExpiresAt: number; // epoch ms
  createdAt: number; // epoch ms
}
