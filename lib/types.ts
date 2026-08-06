export type TierName = "GA" | "VIP";

export interface TicketTier {
  name: TierName;
  priceCents: number;
  totalInventory: number;
}

export interface EventRecord {
  id: string;
  name: string;
  artist: string;
  date: string; // ISO 8601
  venue: string;
  description: string;
  tiers: TicketTier[];
}

export interface TierAvailability extends TicketTier {
  remaining: number;
}

export type OrderStatus = "pending" | "succeeded" | "failed" | "expired";

export interface Order {
  id: string;
  eventId: string;
  tierName: TierName;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  currency: string;
  status: OrderStatus;
  paymentId?: string;
  holdExpiresAt: number; // epoch ms
  createdAt: number; // epoch ms
}
