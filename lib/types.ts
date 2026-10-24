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
  // SHA-256 (lowercase hex) of the guest credential that created the order,
  // bound atomically at reservation (Phase 1B.4). Absent on legacy orders,
  // which are therefore not accessible to any guest. Never sent to a client.
  ownerHash?: string;
}

// The only order fields a guest-facing response carries. Deliberately
// excludes ownerHash and the provider paymentId.
export interface OrderView {
  id: string;
  eventId: string;
  tierName: TierName;
  quantity: number;
  unitPriceCents: number;
  feeCents: number;
  amountCents: number;
  currency: string;
  status: OrderStatus;
  holdExpiresAt: number;
  createdAt: number;
}
