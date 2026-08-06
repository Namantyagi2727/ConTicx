export const HOLD_DURATION_MS = 10 * 60 * 1000;
export const MAX_QUANTITY_PER_ORDER = 4;
export const SERVICE_FEE_RATE = 0.1; // 10% of the ticket subtotal, per ticket
export const DEMAND_WINDOW_SECONDS = 60 * 60; // rolling-ish window for the "N reserved recently" signal
export const DEMAND_DISPLAY_THRESHOLD = 3; // don't show the badge below this — a quiet show shouldn't announce it
