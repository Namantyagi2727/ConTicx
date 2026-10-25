// Narrow fixture helper for the Phase 1B.1 store tests: builds a plausible
// Order with sensible defaults (midnight-parade VIP, qty 1) that any field
// can override. It does NOT touch Redis — tests persist it through the real
// store operation (reserveAndCreateOrder) or seed raw values themselves.

import { randomBytes, randomUUID } from "node:crypto";
import type { Order } from "@/lib/types";

export function makeOrder(overrides: Partial<Order> = {}): Order {
  const now = Date.now();
  return {
    id: randomUUID(),
    eventId: "midnight-parade",
    tierName: "VIP",
    quantity: 1,
    unitPriceCents: 10000,
    feeCents: 1000,
    amountCents: 11000,
    currency: "USD",
    status: "pending",
    holdExpiresAt: now + 10 * 60 * 1000,
    createdAt: now,
    // Phase 1B.4: every new order carries a guest owner (a sha256 hex).
    ownerHash: randomBytes(32).toString("hex"),
    ...overrides,
  };
}
