// Orders and tier inventory counters live in Upstash Redis, not
// in-memory. This is deliberately split from lib/events.ts, which
// stays a hardcoded module:
//
//   - Orders and inventory are read-modify-write state that changes
//     on every purchase, and must be visible to every serverless
//     instance handling this app — a Hyperswitch webhook can land on
//     a completely different instance than the one that created the
//     order, so anything kept in that instance's process memory would
//     silently never see the update. Shared storage is a hard
//     requirement here, not an optimization.
//   - The event catalog is static and read-only. There's nothing to
//     synchronize, so a database round trip would only add latency
//     for no correctness benefit.
//
// Orders are stored as a single JSON value keyed by order id. Inventory
// is a plain Redis integer per (eventId, tierName).
//
// Phase 1B.1 — atomicity. The business operations that mutate this
// state (reserve-and-create, status transitions + inventory release,
// payment-id attachment) run as Redis-side Lua scripts, not as separate
// read/check/write round trips in application code. A single script
// executes with nothing else interleaved, so two competing requests
// cannot both pass the same check before either writes. Each script
// validates its inputs, key types, and transition preconditions BEFORE
// any write — a Lua script is NOT a transaction that rolls back, so a
// write that runs before a later error is not undone; the discipline is
// to check first and write last. See reserveAndCreateOrder /
// transitionOrder / attachPaymentId below.

import { redis } from "./redis";
import { hyperswitchFetch } from "./hyperswitch";
import { DEMAND_WINDOW_SECONDS } from "./constants";
import type { Order, OrderStatus } from "./types";

// ZSET of still-pending order ids, scored by holdExpiresAt. Lets reap
// find "which holds expired" with a single ZRANGE instead of scanning
// every order key (Redis has no cheap way to list all order:* keys).
const PENDING_HOLDS_KEY = "pending_holds";

function orderKey(id: string) {
  return `order:${id}`;
}

function inventoryKey(eventId: string, tierName: string) {
  return `inventory:${eventId}:${tierName}`;
}

function demandKey(eventId: string) {
  return `demand:${eventId}`;
}

// ---------------------------------------------------------------------------
// Atomic Redis-side operations (Lua). KEYS are passed explicitly so the
// key layout stays visible here, and every branch that could fail is
// evaluated before the first write.
// ---------------------------------------------------------------------------

// reserve-and-create: validate quantity, initialize the counter on first
// touch only, check availability, then (and only then) decrement
// inventory, persist the order JSON, and index its hold — together.
// Insufficient inventory leaves no inventory mutation, no order, and no
// hold entry.
//
// Returns: {'OK', remaining} | {'SOLD_OUT', remaining} | {'ERR', reason}
const RESERVE_AND_CREATE_SCRIPT = `
local invKey = KEYS[1]
local orderKey = KEYS[2]
local holdsKey = KEYS[3]
local qty = tonumber(ARGV[1])
local total = tonumber(ARGV[2])
local orderJson = ARGV[3]
local orderId = ARGV[4]
local holdExpiresAt = tonumber(ARGV[5])

if not qty or qty < 1 then return {'ERR', 'bad_quantity'} end
if not total or total < 0 then return {'ERR', 'bad_total'} end
if not holdExpiresAt then return {'ERR', 'bad_hold'} end
if not orderJson or orderJson == '' then return {'ERR', 'bad_order'} end

local invType = redis.call('TYPE', invKey).ok
if invType ~= 'string' and invType ~= 'none' then return {'ERR', 'inv_type'} end

-- Determine current availability WITHOUT mutating anything, so an
-- insufficient request leaves the counter exactly as it found it (no
-- seed, no decrement). An absent counter means an untouched tier, whose
-- availability is its full total. We never reseed an EXISTING counter,
-- so a counter lost out-of-band surfaces as 'inv_nan' rather than
-- silently resetting availability to full while holds may still exist.
local remaining
if invType == 'none' then
  remaining = total
else
  remaining = tonumber(redis.call('GET', invKey))
  if not remaining then return {'ERR', 'inv_nan'} end
end

if remaining < qty then
  return {'SOLD_OUT', remaining}
end

-- Writes only below this line; none can fail on the validated inputs.
-- Explicit first-touch initialization happens here, only on the path
-- that actually reserves.
if invType == 'none' then
  redis.call('SET', invKey, total)
end
local after = redis.call('DECRBY', invKey, qty)
redis.call('SET', orderKey, orderJson)
redis.call('ZADD', holdsKey, holdExpiresAt, orderId)
return {'OK', after}
`;

// guarded status transition (compare-and-set) with its inventory effect.
// Applies ONLY when the order is currently in the expected 'from' state;
// if it is already in the 'to' state the call is an idempotent no-op
// (NOOP), and any other state is an incompatible transition (CONFLICT).
// Status change, hold removal, and the optional inventory release happen
// together, so a retried or concurrent caller can never apply the
// inventory effect twice.
//
// Returns: {'OK', prevStatus} | {'NOOP', curStatus} | {'CONFLICT', curStatus}
//        | {'NOT_FOUND'} | {'ERR', reason}
const TRANSITION_SCRIPT = `
local orderKey = KEYS[1]
local invKey = KEYS[2]
local holdsKey = KEYS[3]
local orderId = ARGV[1]
local expectedFrom = ARGV[2]
local toStatus = ARGV[3]
local release = ARGV[4] == '1'

local raw = redis.call('GET', orderKey)
if not raw then return {'NOT_FOUND'} end
local ok, order = pcall(cjson.decode, raw)
if not ok or type(order) ~= 'table' then return {'ERR', 'bad_order_json'} end

local cur = order['status']
if cur == toStatus then return {'NOOP', tostring(cur)} end
if cur ~= expectedFrom then return {'CONFLICT', tostring(cur)} end

local qty = tonumber(order['quantity'])
if release then
  if not qty or qty < 0 then return {'ERR', 'bad_quantity'} end
  local invType = redis.call('TYPE', invKey).ok
  if invType ~= 'string' and invType ~= 'none' then return {'ERR', 'inv_type'} end
end

-- Writes only below this line.
order['status'] = toStatus
redis.call('SET', orderKey, cjson.encode(order))
redis.call('ZREM', holdsKey, orderId)
if release then
  redis.call('INCRBY', invKey, qty)
end
return {'OK', tostring(cur)}
`;

// payment-id attachment: set ONLY the paymentId field on whatever the
// current stored order is. Never rewrites status or re-adds a hold (so
// it cannot resurrect a resolved order), treats re-attaching the same id
// as a no-op, and refuses to overwrite a different id.
//
// Returns: {'OK'} | {'NOOP'} | {'CONFLICT', existing} | {'NOT_FOUND'}
//        | {'ERR', reason}
const ATTACH_PAYMENT_SCRIPT = `
local orderKey = KEYS[1]
local paymentId = ARGV[1]

if not paymentId or paymentId == '' then return {'ERR', 'bad_payment_id'} end

local raw = redis.call('GET', orderKey)
if not raw then return {'NOT_FOUND'} end
local ok, order = pcall(cjson.decode, raw)
if not ok or type(order) ~= 'table' then return {'ERR', 'bad_order_json'} end

local existing = order['paymentId']
if existing == paymentId then return {'NOOP'} end
if existing ~= nil and existing ~= cjson.null then return {'CONFLICT', tostring(existing)} end

order['paymentId'] = paymentId
redis.call('SET', orderKey, cjson.encode(order))
return {'OK'}
`;

export type ReserveResult = "created" | "sold_out" | "error";
export type TransitionResult = "applied" | "noop" | "conflict" | "not_found" | "error";
export type AttachResult = "ok" | "noop" | "conflict" | "not_found" | "error";

async function evalScript(script: string, keys: string[], args: string[]): Promise<unknown[]> {
  const result = (await redis.eval(script, keys, args)) as unknown;
  return Array.isArray(result) ? result : [result];
}

function resultCode(result: unknown[]): string {
  return typeof result[0] === "string" ? result[0] : String(result[0]);
}

// Raw read, no reap side effect. Used internally by the transition
// helpers and by reap itself — both already know a fresh reap pass
// doesn't need to run again on their behalf, and going through the
// public getOrder (which reaps first) would deadlock reap, which awaits
// these helpers.
async function readOrder(id: string): Promise<Order | undefined> {
  const order = await redis.get<Order>(orderKey(id));
  return order ?? undefined;
}

// Seeds the inventory counter to the tier's total the first time it's
// read for display. SETNX is atomic: concurrent initializers don't
// clobber each other. (reserveAndCreateOrder does its own first-touch
// seed inside the script; this exists for the read path below.)
async function ensureInventoryInitialized(key: string, totalInventory: number) {
  await redis.setnx(key, totalInventory);
}

// Cancels the Hyperswitch intent for a genuinely-expired pending hold
// before releasing its inventory — see the comment on the loop body
// for the race this guards against. Guarded by a single in-flight
// promise: getRemainingInventory is called once per tier, and
// Promise.all-ing those calls (as the event page does for GA + VIP
// together) would otherwise start two concurrent reap passes that
// both see the same expired order and both race to cancel the same
// payment_id — whichever cancel response loses that race gets
// rejected by Hyperswitch and would incorrectly read as "already
// paid". Joining concurrent callers onto the same pass removes that
// race entirely. Note this guard is per serverless instance, not
// global — Redis's atomicity is what keeps two *different* instances
// reaping at the same moment from double-cancelling, same as it keeps
// two concurrent reservations from overselling.
let reapInFlight: Promise<void> | null = null;

async function reapExpiredHolds(): Promise<void> {
  if (reapInFlight) return reapInFlight;

  reapInFlight = (async () => {
    const now = Date.now();
    const expiredIds = await redis.zrange<string[]>(PENDING_HOLDS_KEY, "-inf", now, {
      byScore: true,
    });

    for (const orderId of expiredIds) {
      const order = await readOrder(orderId);
      if (!order || order.status !== "pending") {
        // Already resolved (webhook, another instance's reap pass, or
        // a stale entry) — drop it so we stop re-checking it.
        await redis.zrem(PENDING_HOLDS_KEY, orderId);
        continue;
      }

      if (!order.paymentId) {
        await updateOrderStatus(order.id, "expired");
        continue;
      }

      // The race this guards against: a shopper's payment can succeed
      // at Hyperswitch in the same moment their 10-minute hold ticks
      // over (a slow bank auth, a redirect flow, a browser tab left
      // open). If we freed the inventory purely on the clock, we
      // could resell a seat that was just paid for. So cancelling the
      // intent always comes first, and the order's fate depends on
      // what Hyperswitch says:
      //   - cancel succeeds -> the intent was still in a cancellable
      //     state, so it was genuinely unpaid. Safe to expire and
      //     release the hold.
      //   - cancel is rejected with 400 (IR_16, "cannot cancel from
      //     status X") -> the intent moved past a cancellable state,
      //     which for a payment we created can only mean it succeeded
      //     or is mid-flight. Treat the order as paid and keep its
      //     inventory reserved.
      //   - cancel fails for any other reason (network error, 401,
      //     5xx) -> inconclusive. Leave the order pending and retry
      //     on the next reap instead of guessing either way.
      //
      // NOTE (tracked defect INV-01): reading a 400 as "paid" is an
      // over-broad inference a 400 does not justify. Phase 1B.1 does
      // not change this interpretation — it only makes the resulting
      // transition atomic. Re-fetching the real payment status after a
      // non-2xx cancel is deferred to a later subphase.
      try {
        const response = await hyperswitchFetch(
          `/payments/${order.paymentId}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({ cancellation_reason: "hold_expired" }),
          }
        );

        if (response.ok) {
          await updateOrderStatus(order.id, "expired");
        } else if (response.status === 400) {
          await updateOrderStatus(order.id, "succeeded");
        }
      } catch {
        // Network/infra error — inconclusive, leave pending.
      }
    }
  })();

  try {
    await reapInFlight;
  } finally {
    reapInFlight = null;
  }
}

export async function getRemainingInventory(
  eventId: string,
  tierName: string,
  totalInventory: number
): Promise<number> {
  await reapExpiredHolds();
  const key = inventoryKey(eventId, tierName);
  await ensureInventoryInitialized(key, totalInventory);
  const remaining = await redis.get<number>(key);
  // Clamped on both ends for DISPLAY only: never below 0, never above
  // totalInventory. This is a read-time presentation safety net, not
  // evidence that accounting is correct — the integration tests assert
  // the RAW counter, never this clamped value. The counter should never
  // legitimately drift outside [0, totalInventory]; clamping only keeps
  // a drifted value (e.g. from a manual test-DB edit) from showing
  // "112% sold" downstream.
  return Math.min(totalInventory, Math.max(0, remaining ?? totalInventory));
}

// Atomically reserve `quantity` units AND persist the order and its hold
// together (see RESERVE_AND_CREATE_SCRIPT). Either all of it happens or
// none of it does, closing the old gap where a decrement could land with
// no recoverable order to reap.
export async function reserveAndCreateOrder(
  order: Order,
  totalInventory: number
): Promise<ReserveResult> {
  await reapExpiredHolds();
  const result = await evalScript(
    RESERVE_AND_CREATE_SCRIPT,
    [inventoryKey(order.eventId, order.tierName), orderKey(order.id), PENDING_HOLDS_KEY],
    [
      String(order.quantity),
      String(totalInventory),
      JSON.stringify(order),
      order.id,
      String(order.holdExpiresAt),
    ]
  );
  const code = resultCode(result);
  if (code === "OK") return "created";
  if (code === "SOLD_OUT") return "sold_out";
  return "error";
}

// Guarded compare-and-set status transition with its inventory effect.
// Exposed for callers that need the precise outcome (and for tests);
// updateOrderStatus and markOrderRefunded wrap it with fixed semantics.
export async function transitionOrder(
  id: string,
  from: OrderStatus,
  to: OrderStatus,
  releasesInventory: boolean
): Promise<TransitionResult> {
  // Read once to derive the inventory key (eventId/tierName never change
  // for an order). The transition's correctness does not depend on this
  // read — the script re-checks the status atomically — so a status that
  // changes between here and the eval is handled as NOOP/CONFLICT.
  const order = await readOrder(id);
  if (!order) return "not_found";

  const result = await evalScript(
    TRANSITION_SCRIPT,
    [orderKey(id), inventoryKey(order.eventId, order.tierName), PENDING_HOLDS_KEY],
    [id, from, to, releasesInventory ? "1" : "0"]
  );
  const code = resultCode(result);
  if (code === "OK") return "applied";
  if (code === "NOOP") return "noop";
  if (code === "CONFLICT") return "conflict";
  if (code === "NOT_FOUND") return "not_found";
  return "error";
}

// Statuses whose transition from pending releases the held inventory
// back to the tier. succeeded keeps the seat.
const RELEASING_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["failed", "expired"]);

// Authoritative pending -> terminal transition driven by the payment
// status route, the webhook handler, the reaper, or the order route's
// own provider-failure path. Atomic and idempotent by construction: a
// redelivered webhook, a reconcile racing the webhook, or a reap racing
// either one all resolve to a single applied transition — the others see
// a non-pending status and no-op, never a second inventory release.
export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  await transitionOrder(id, "pending", status, RELEASING_STATUSES.has(status));
}

// Marks a succeeded order refunded and releases its inventory, exactly
// once. Returns true only when THIS call performed the transition; a
// duplicate/retried/concurrent refund returns false (already refunded,
// or not in a refundable state) and causes no second release. This is
// the local idempotency guard the refund route relies on. It does NOT
// make the provider-side refund idempotent — two concurrent refund
// requests can still each reach Hyperswitch (deferred to a later
// subphase); this guarantee is only about local inventory accounting.
export async function markOrderRefunded(id: string): Promise<boolean> {
  return (await transitionOrder(id, "succeeded", "refunded", true)) === "applied";
}

// Attaches the provider payment id to an existing order without
// rewriting any other field. Safe to repeat (same id -> noop) and
// refuses to clobber a different id (conflict); never resurrects a
// resolved order's status or hold.
export async function attachPaymentId(id: string, paymentId: string): Promise<AttachResult> {
  const result = await evalScript(ATTACH_PAYMENT_SCRIPT, [orderKey(id)], [paymentId]);
  const code = resultCode(result);
  if (code === "OK") return "ok";
  if (code === "NOOP") return "noop";
  if (code === "CONFLICT") return "conflict";
  if (code === "NOT_FOUND") return "not_found";
  return "error";
}

export async function getOrder(id: string): Promise<Order | undefined> {
  await reapExpiredHolds();
  return readOrder(id);
}

// Lightweight "how much interest is this event getting right now"
// counter, purely for the event page's demand signal — not tied to
// inventory or order status. Counts reservation attempts (not just
// completed payments), since the point is "people are actively trying
// to buy this," the same thing a real ticketing site's "N people
// looking at this" or "N sold in the last hour" badge is signaling.
//
// This is an approximate rolling window, not a true sliding one: the
// counter resets to 0 (via EXPIRE) roughly DEMAND_WINDOW_SECONDS after
// the *first* reservation in the current window, not exactly N seconds
// before "now" for every read. Good enough for a demand badge; not
// something to build billing or analytics on.
export async function recordDemandSignal(eventId: string): Promise<void> {
  const key = demandKey(eventId);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, DEMAND_WINDOW_SECONDS);
  }
}

export async function getRecentDemand(eventId: string): Promise<number> {
  const count = await redis.get<number>(demandKey(eventId));
  return count ?? 0;
}
