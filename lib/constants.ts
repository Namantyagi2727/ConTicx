export const HOLD_DURATION_MS = 10 * 60 * 1000;
export const MAX_QUANTITY_PER_ORDER = 4;
export const SERVICE_FEE_RATE = 0.1; // 10% of the ticket subtotal, per ticket
export const DEMAND_WINDOW_SECONDS = 60 * 60; // rolling-ish window for the "N reserved recently" signal
export const DEMAND_DISPLAY_THRESHOLD = 3; // don't show the badge below this — a quiet show shouldn't announce it

// Explicit safe upper bound for any tier inventory counter, capacity, or
// reservation quantity. Far above any real venue, and comfortably within
// both Redis's 64-bit integer range and JS Number.MAX_SAFE_INTEGER, so
// inventory arithmetic (DECRBY/INCRBY) cannot overflow. Used by the store
// scripts to reject out-of-range or unsafe values before any write.
export const MAX_INVENTORY = 1_000_000_000;
