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

// Retention for the webhook-event dedup marker (see the Hyperswitch webhook
// handler). Hyperswitch retries an undelivered webhook for up to 24 hours,
// so the "already processed" marker must outlive that window for a late
// retry of an already-handled delivery to be recognized and skipped; after
// that it expires so the keyspace does not grow without bound. 7 days = the
// 24h retry window plus generous slack. The marker is an optimization to
// skip duplicate provider reads, NOT the mechanism that prevents duplicate
// business effects — the atomic Phase 1B.1 transitions are.
export const WEBHOOK_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Lazy hold expiry (reapExpiredHolds) processes at most this many expired
// holds per pass, oldest first, and each one makes a bounded number of
// provider calls (retrieve, at most one cancel, one re-retrieve). This caps
// the work a single request can trigger: a large backlog or a provider
// outage is worked off across many passes instead of one request looping
// over every expired order.
export const HOLD_EXPIRY_BATCH_SIZE = 20;

// Provider-wait budget for request-triggered expiry. Expiry runs inline in
// front of an ordinary request (an availability read, order creation), so
// without this the batch cap alone would allow 20 holds x 3 calls x 10 s of
// provider waiting. The budget is the TOTAL wall time spent inside provider
// calls by expiry on one instance within one budget window; each call's
// timeout is capped at the remaining budget, and no new provider call starts
// once fewer than HOLD_EXPIRY_MIN_CALL_MS remain. 2 s keeps the worst-case
// added latency of housekeeping modest while still letting a normal
// sandbox-latency pass (~100-500 ms per call) make real progress.
//
// The window groups the several expiry passes one request can trigger
// (order creation runs up to three) so they share one budget instead of
// each getting a fresh one. A request that straddles a window boundary can
// see at most two windows' budget. Redis round trips and other overhead are
// NOT counted — this bounds provider waiting, not end-to-end latency.
// Overridable via HOLD_EXPIRY_PROVIDER_BUDGET_MS (read per pass) for tuning
// and tests.
export const HOLD_EXPIRY_PROVIDER_BUDGET_MS = 2_000;
export const HOLD_EXPIRY_BUDGET_WINDOW_MS = 10_000;
export const HOLD_EXPIRY_MIN_CALL_MS = 250;

// TTL for the per-order "a provider payment was attempted" marker, set just
// before the payment is created and cleared once its id is attached. It is
// DIAGNOSTIC ONLY: when an expired hold has no attached payment id, expiry
// records whether the marker was present in the reconciliation reason. Its
// absence is never treated as proof that no payment exists (such an order
// is always retained). Comfortably longer than the hold window plus any
// lazy-reap lag.
export const PAYMENT_ATTEMPT_TTL_SECONDS = 24 * 60 * 60;

// Guest ownership (Phase 1B.4). A guest session is a server-issued random
// credential in an HttpOnly cookie; the server keeps only its SHA-256 hash,
// as a session record that expires after this long and as the owner of
// each order created with it. The lifetime is SLIDING: it restarts whenever
// the browser re-establishes the session (before every booking, and when My
// Tickets is opened), and the cookie's Max-Age is renewed to match. After
// it lapses — or if the browser's data is cleared — this browser can no
// longer reach those orders; there is no cross-device or email recovery yet.
export const GUEST_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

// Upper bound on how many of a guest's orders the My Tickets listing
// returns (newest first). Far above normal use; it only bounds the work one
// listing request can trigger.
export const GUEST_ORDER_LIST_LIMIT = 50;
