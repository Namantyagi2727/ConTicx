// Deliberate prototype scope: orders and inventory holds live in a
// single in-memory Map, not a database. Attaching it to globalThis
// keeps it stable across Next.js dev hot-reloads and warm serverless
// invocations, but it resets on a cold start or redeploy — fine for a
// live demo, not for production.

import type { Order, OrderStatus } from "./types";

const g = globalThis as unknown as { __conticxOrders?: Map<string, Order> };
const orders: Map<string, Order> = g.__conticxOrders ?? (g.__conticxOrders = new Map());

// Flips any pending order whose hold has expired to "expired", freeing
// its inventory for other buyers. Run lazily on every read/write
// instead of a background timer, since this runs on serverless.
function reapExpiredHolds() {
  const now = Date.now();
  for (const order of orders.values()) {
    if (order.status === "pending" && order.holdExpiresAt < now) {
      order.status = "expired";
    }
  }
}

export function getRemainingInventory(
  eventId: string,
  tierName: string,
  totalInventory: number
): number {
  reapExpiredHolds();
  let taken = 0;
  for (const order of orders.values()) {
    if (
      order.eventId === eventId &&
      order.tierName === tierName &&
      (order.status === "pending" || order.status === "succeeded")
    ) {
      taken += order.quantity;
    }
  }
  return Math.max(0, totalInventory - taken);
}

export function createOrder(order: Order) {
  reapExpiredHolds();
  orders.set(order.id, order);
}

export function getOrder(id: string): Order | undefined {
  reapExpiredHolds();
  return orders.get(id);
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  const order = orders.get(id);
  if (order) order.status = status;
}
