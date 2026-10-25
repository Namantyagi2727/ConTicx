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

import { randomUUID } from "node:crypto";
import { redis } from "./redis";
import { errorKind, logEvent } from "./log";
import {
  hyperswitchFetch,
  retrievePayment,
  type ProviderPayment,
  type RetrievePaymentResult,
} from "./hyperswitch";
import {
  DEMAND_WINDOW_SECONDS,
  HOLD_EXPIRY_BATCH_SIZE,
  HOLD_EXPIRY_BUDGET_WINDOW_MS,
  HOLD_EXPIRY_MIN_CALL_MS,
  HOLD_EXPIRY_PROVIDER_BUDGET_MS,
  MAX_INVENTORY,
  PAYMENT_ATTEMPT_TTL_SECONDS,
  WEBHOOK_EVENT_TTL_SECONDS,
} from "./constants";
import { bindPaymentToOrder, decideFromStatus, type Decision } from "./payment-policy";
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

// Persistent evidence that a tier's inventory was initialized. Set once,
// atomically, the first time a tier is seeded, and never deleted by the
// app. It lets us tell a genuinely new tier (no counter AND no init
// record) apart from a tier whose counter was lost out-of-band (no
// counter BUT init record present) — an absent counter alone cannot.
function inventoryInitKey(eventId: string, tierName: string) {
  return `inventory_init:${eventId}:${tierName}`;
}

function demandKey(eventId: string) {
  return `demand:${eventId}`;
}

// Durable "needs human/later reconciliation" record for one order, carrying
// a bounded non-sensitive reason and a timestamp. A SEPARATE key (not a
// field on the order) so recording it never does a whole-order stale write
// and never touches inventory. Persistent on purpose — it is a backlog item
// the recovery phase owns, not a transient marker.
function reconcileKey(id: string) {
  return `reconcile:${id}`;
}

// ZSET of every order id that currently has a reconciliation flag, scored by
// when it was (last) flagged. Written atomically with the flag, so unresolved
// work stays enumerable (ZRANGE) after it leaves the pending-holds index —
// a per-order key alone could only be found by scanning the keyspace.
const RECONCILE_INDEX_KEY = "reconcile_needed";

// Per-guest index of the orders that guest created (Phase 1B.4), scored by
// createdAt. Written only inside RESERVE_AND_CREATE_SCRIPT, in the same step
// as the order and its owner, so the My Tickets listing reads a guest's own
// orders without scanning the keyspace.
function guestOrdersKey(ownerHash: string) {
  return `guest_orders:${ownerHash}`;
}

// Per-guest booking-attempt record (Phase 1B.5): binds one attempt id to one
// order and its canonical request. Written only inside
// RESERVE_AND_CREATE_SCRIPT and never expires — an attempt must not lapse
// while its order (and any unresolved payment) still exists, or a retry
// could be recreated as a fresh booking. Scoped by owner hash, so another
// guest presenting the same attempt id addresses a different record.
function bookingAttemptKey(ownerHash: string, attemptId: string) {
  return `booking_attempt:${ownerHash}:${attemptId}`;
}

// Payment-creation lease for one order (Phase 1B.5). See
// BOOKING_PAYMENT_LEASE_MS: an optimisation against redundant provider
// calls, never the justification for retrying one.
function paymentLeaseKey(orderId: string) {
  return `payment_create_lease:${orderId}`;
}

// Per-order marker that a provider payment was ATTEMPTED (set just before
// the create call, cleared once its id is attached). Read only when an
// expired hold has no attached payment id.
function paymentAttemptKey(id: string) {
  return `payment_attempt:${id}`;
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
// Phase 1B.4: the order MUST carry its guest owner (ownerHash, 64 lowercase
// hex), which is written in the same step as the order itself and indexed
// in the owner's order list (KEYS[5], guest_orders:<ownerHash>). Ownership
// is never attached afterwards, and a replay under a different owner — or
// against a legacy order that has no owner — is a CONFLICT with no write.
//
// Phase 1B.5: the order MUST also carry its booking attempt (attemptId, a
// UUID) and its provider payment identity (paymentRequestId, "pay_" + 26
// lowercase alphanumerics = 30 chars). The attempt record (KEYS[6],
// booking_attempt:<ownerHash>:<attemptId>) is written in the same step and
// never expires. When the attempt is already bound to another order, the
// script returns that order instead of booking again: ATTEMPT_EXISTS if the
// canonical request (event, tier, quantity) matches, ATTEMPT_CONFLICT if
// not — either way with no write. Pricing, timestamps, hold expiry, and the
// payment identity therefore always come from the ORIGINAL order.
//
// Returns: {'OK', remaining} | {'SOLD_OUT', remaining} | {'EXISTS', status}
//        | {'CONFLICT', status} | {'ATTEMPT_EXISTS', orderId}
//        | {'ATTEMPT_CONFLICT', orderId} | {'LOST'} | {'ERR', reason}
const RESERVE_AND_CREATE_SCRIPT = `
local invKey = KEYS[1]
local orderKey = KEYS[2]
local holdsKey = KEYS[3]
local initKey = KEYS[4]
local ownerIndexKey = KEYS[5]
local attemptKey = KEYS[6]
local orderJson = ARGV[1]
local total = tonumber(ARGV[2])
local maxInv = tonumber(ARGV[3])

if not orderJson or orderJson == '' then return {'ERR', 'bad_order'} end
if not maxInv or maxInv < 1 then return {'ERR', 'bad_max'} end
-- Capacity must be a non-negative integer within the explicit safe bound.
if not total or total ~= math.floor(total) or total < 0 or total > maxInv then
  return {'ERR', 'bad_total'}
end

local okIn, incoming = pcall(cjson.decode, orderJson)
if not okIn or type(incoming) ~= 'table' then return {'ERR', 'bad_order_json'} end
local orderId = incoming['id']
local qty = incoming['quantity']
local holdExpiresAt = tonumber(incoming['holdExpiresAt'])
local eventId = incoming['eventId']
local tierName = incoming['tierName']
local currency = incoming['currency']
local unitPrice = tonumber(incoming['unitPriceCents'])
local fee = tonumber(incoming['feeCents'])
local amount = tonumber(incoming['amountCents'])
local owner = incoming['ownerHash']
local createdAt = tonumber(incoming['createdAt'])
if not orderId or orderId == '' then return {'ERR', 'bad_order_id'} end
-- Owner must be a SHA-256 hex digest, and the index key must be that
-- owner's: a caller cannot index an order under someone else's list.
if type(owner) ~= 'string' or #owner ~= 64 or not string.match(owner, '^[0-9a-f]+$') then
  return {'ERR', 'bad_owner'}
end
if ownerIndexKey ~= 'guest_orders:' .. owner then return {'ERR', 'bad_owner_index'} end
if not createdAt then return {'ERR', 'bad_created_at'} end
-- Booking attempt: a lowercase UUID, and the attempt key must be this
-- owner's record for it (attempts are scoped per guest).
local attemptId = incoming['attemptId']
if type(attemptId) ~= 'string' or #attemptId ~= 36 or not string.match(attemptId, '^[0-9a-f-]+$') then
  return {'ERR', 'bad_attempt'}
end
if attemptKey ~= 'booking_attempt:' .. owner .. ':' .. attemptId then return {'ERR', 'bad_attempt_key'} end
-- Provider payment identity, fixed before any provider call.
local payReq = incoming['paymentRequestId']
if type(payReq) ~= 'string' or #payReq ~= 30 or not string.match(payReq, '^pay_[a-z0-9]+$') then
  return {'ERR', 'bad_payment_request_id'}
end
-- Quantity must be a POSITIVE INTEGER within the safe bound: a value Lua
-- could parse numerically (e.g. 1.5) is not enough — DECRBY needs a whole
-- number and the result must stay in range.
if type(qty) ~= 'number' or qty ~= math.floor(qty) or qty < 1 or qty > maxInv then
  return {'ERR', 'bad_quantity'}
end
if not holdExpiresAt then return {'ERR', 'bad_hold'} end

-- Type-check every key we may write BEFORE any mutation, so a corrupt
-- key surfaces as an error rather than a partial write (Lua does not roll
-- back writes that ran before a later error).
local invType = redis.call('TYPE', invKey).ok
if invType ~= 'string' and invType ~= 'none' then return {'ERR', 'inv_type'} end
local holdsType = redis.call('TYPE', holdsKey).ok
if holdsType ~= 'zset' and holdsType ~= 'none' then return {'ERR', 'holds_type'} end
local ownerIndexType = redis.call('TYPE', ownerIndexKey).ok
if ownerIndexType ~= 'zset' and ownerIndexType ~= 'none' then return {'ERR', 'owner_index_type'} end
local attemptType = redis.call('TYPE', attemptKey).ok
if attemptType ~= 'string' and attemptType ~= 'none' then return {'ERR', 'attempt_type'} end

-- Replay / order-id collision guard. Never overwrite an existing order,
-- reset its status, recreate its hold, or decrement again. A matching
-- resubmission of the same booking returns EXISTS with the order's
-- CURRENT status (the existing-operation result); a different booking
-- under the same id is a CONFLICT. Either way: no mutation.
local existingRaw = redis.call('GET', orderKey)
if existingRaw then
  local okEx, existing = pcall(cjson.decode, existingRaw)
  if not okEx or type(existing) ~= 'table' then return {'ERR', 'bad_existing_json'} end
  -- Immutable booking fields compared on replay. Differing currency or
  -- any part of the pricing breakdown (unit price / fee / total) is a
  -- CONFLICT, never a matching result — even when the totals coincide.
  -- Timestamps (createdAt) and holdExpiresAt are deliberately NOT
  -- compared: they belong to the original attempt and are retained from
  -- the stored order (EXISTS returns without overwriting), so a matching
  -- retry preserves the original hold window, progressed status, and any
  -- payment association.
  --
  -- The owner is part of the comparison: the same booking replayed by a
  -- DIFFERENT guest is a CONFLICT, so an existing order (including a legacy
  -- one with no owner) can never be claimed through a replay.
  local sameBooking =
    existing['ownerHash'] == owner and
    existing['eventId'] == eventId and
    existing['tierName'] == tierName and
    existing['currency'] == currency and
    tonumber(existing['quantity']) == qty and
    tonumber(existing['unitPriceCents']) == unitPrice and
    tonumber(existing['feeCents']) == fee and
    tonumber(existing['amountCents']) == amount
  if sameBooking then
    return {'EXISTS', tostring(existing['status'])}
  end
  return {'CONFLICT', tostring(existing['status'])}
end

-- Booking-attempt replay. The attempt is already bound to an order (under a
-- different order id, or the order-id check above would have answered):
-- return that order, never book again. Only the canonical client request
-- is compared; the bound order keeps its original server-side pricing.
if attemptType == 'string' then
  local okA, attempt = pcall(cjson.decode, redis.call('GET', attemptKey))
  if not okA or type(attempt) ~= 'table' or type(attempt['orderId']) ~= 'string' then
    return {'ERR', 'bad_attempt_json'}
  end
  if attempt['eventId'] == eventId and attempt['tierName'] == tierName
      and tonumber(attempt['quantity']) == qty then
    return {'ATTEMPT_EXISTS', attempt['orderId']}
  end
  return {'ATTEMPT_CONFLICT', attempt['orderId']}
end

-- Availability WITHOUT mutation, distinguishing a genuinely new tier from
-- a lost counter. counter present -> use it; counter absent + init record
-- present -> LOST (initialized before, counter now gone: refuse, do not
-- reseed); neither present -> genuinely new (seed on the reserving path).
local remaining
local needSeed = false
if invType == 'string' then
  -- The counter must be a CANONICAL non-negative integer string that
  -- Redis integer ops accept — not merely something tonumber parses.
  -- This rejects corrupt values like "1.5", "1.0", "1e2", or a
  -- leading-zero form like "01" (Redis integer parsing rejects leading
  -- zeros; only "0" itself is a zero) instead of silently normalizing
  -- them, and it is not reseeded. Lua patterns have no alternation, so
  -- "canonical" is: exactly "0", or 1-9 then any digits.
  local cs = redis.call('GET', invKey)
  if type(cs) ~= 'string' or not (cs == '0' or string.match(cs, '^[1-9]%d*$')) then
    return {'ERR', 'inv_nan'}
  end
  remaining = tonumber(cs)
  if not remaining or remaining > maxInv then return {'ERR', 'inv_range'} end
else
  if redis.call('EXISTS', initKey) == 1 then
    return {'LOST'}
  end
  remaining = total
  needSeed = true
end

if remaining < qty then
  return {'SOLD_OUT', remaining}
end

-- Writes only below this line. Every key was type-checked above, so none
-- of these can error midway and strand a partial write.
if needSeed then
  redis.call('SET', initKey, total)
  redis.call('SET', invKey, total)
end
local after = redis.call('DECRBY', invKey, qty)
redis.call('SET', orderKey, orderJson)
redis.call('ZADD', holdsKey, holdExpiresAt, orderId)
redis.call('ZADD', ownerIndexKey, createdAt, orderId)
redis.call('SET', attemptKey, cjson.encode({
  orderId = orderId, eventId = eventId, tierName = tierName, quantity = qty, createdAt = createdAt
}))
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
//        | {'HAS_PAYMENT'} | {'NOT_FOUND'} | {'ERR', reason}
const TRANSITION_SCRIPT = `
local orderKey = KEYS[1]
local invKey = KEYS[2]
local holdsKey = KEYS[3]
local orderId = ARGV[1]
local expectedFrom = ARGV[2]
local toStatus = ARGV[3]
local release = ARGV[4] == '1'
local maxInv = tonumber(ARGV[5])
-- Phase 1B.5: when set, refuse to transition an order that already has a
-- confirmed payment attached (HAS_PAYMENT) — a stale request that saw a
-- definitive provider rejection must not fail an order whose payment
-- another request has since confirmed.
local requireNoPaymentId = ARGV[6] == '1'

if not maxInv or maxInv < 1 then return {'ERR', 'bad_max'} end

local raw = redis.call('GET', orderKey)
if not raw then return {'NOT_FOUND'} end
local ok, order = pcall(cjson.decode, raw)
if not ok or type(order) ~= 'table' then return {'ERR', 'bad_order_json'} end

local cur = order['status']
if cur == toStatus then return {'NOOP', tostring(cur)} end
if cur ~= expectedFrom then return {'CONFLICT', tostring(cur)} end
if requireNoPaymentId then
  local pid = order['paymentId']
  if pid ~= nil and pid ~= cjson.null and pid ~= '' then return {'HAS_PAYMENT'} end
end

-- Validate every key we will write BEFORE mutating. We always ZREM the
-- hold, so the hold index must be a zset (or absent). For a releasing
-- transition, the counter must EXIST and hold a number: a missing counter
-- means the tier was initialized (this order was reserved) but its
-- counter is now gone, so we refuse rather than recreate it from
-- incomplete accounting via INCRBY.
local holdsType = redis.call('TYPE', holdsKey).ok
if holdsType ~= 'zset' and holdsType ~= 'none' then return {'ERR', 'holds_type'} end

local qty
if release then
  -- The released quantity (from the stored order) must be a POSITIVE
  -- INTEGER within the safe bound — rejecting zero/fractional/out-of-range
  -- stored quantities before INCRBY.
  qty = order['quantity']
  if type(qty) ~= 'number' or qty ~= math.floor(qty) or qty < 1 or qty > maxInv then
    return {'ERR', 'bad_quantity'}
  end
  -- The counter must EXIST and be a canonical non-negative integer string
  -- (a missing counter here means a lost counter: refuse, don't recreate).
  -- And the result must not exceed the safe bound, so INCRBY cannot
  -- overflow. "Canonical" rejects leading-zero forms like "01" that Redis
  -- integer ops reject; only "0" itself is a zero.
  if redis.call('TYPE', invKey).ok ~= 'string' then return {'ERR', 'inv_missing'} end
  local cs = redis.call('GET', invKey)
  if not (cs == '0' or string.match(cs, '^[1-9]%d*$')) then return {'ERR', 'inv_nan'} end
  local curCount = tonumber(cs)
  if not curCount or curCount > maxInv then return {'ERR', 'inv_range'} end
  if curCount + qty > maxInv then return {'ERR', 'inv_overflow'} end
end

-- Writes only below this line; every key above was validated, so none of
-- these can error midway and strand a partial write.
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

// record a reconciliation flag, atomically with its index entry, optionally
// moving the order out of the pending-holds index in the same step.
//   mode 'record'  : SET flag + ZADD index. No order checks (used for flags
//                    written alongside a decision, e.g. a retained failed
//                    payment or a late conflict).
//   mode 'dequeue' : only while the order is still pending — and, when
//                    requireNoPaymentId is '1', still has NO payment id —
//                    SET flag + ZADD index + ZREM hold together. If the order
//                    is gone or no longer pending, just drop the stale hold
//                    (RESOLVED, no flag). If a payment id has been attached
//                    since the caller's read, change nothing (HAS_PAYMENT):
//                    this closes the stale-snapshot window between reading
//                    the order and acting on it.
// Because flag and dequeue are one script, a hold can never leave the
// pending index without its flag being recorded.
//
// Returns: {'FLAGGED'} | {'RESOLVED'} | {'HAS_PAYMENT'} | {'ERR', reason}
const RECORD_RECONCILE_SCRIPT = `
local orderKey = KEYS[1]
local holdsKey = KEYS[2]
local flagKey = KEYS[3]
local indexKey = KEYS[4]
local orderId = ARGV[1]
local flagJson = ARGV[2]
local at = tonumber(ARGV[3])
local mode = ARGV[4]
local requireNoPaymentId = ARGV[5] == '1'

if not orderId or orderId == '' then return {'ERR', 'bad_order_id'} end
if not flagJson or flagJson == '' then return {'ERR', 'bad_flag'} end
if not at then return {'ERR', 'bad_at'} end
if mode ~= 'record' and mode ~= 'dequeue' then return {'ERR', 'bad_mode'} end

local flagType = redis.call('TYPE', flagKey).ok
if flagType ~= 'string' and flagType ~= 'none' then return {'ERR', 'flag_type'} end
local indexType = redis.call('TYPE', indexKey).ok
if indexType ~= 'zset' and indexType ~= 'none' then return {'ERR', 'index_type'} end

if mode == 'dequeue' then
  local holdsType = redis.call('TYPE', holdsKey).ok
  if holdsType ~= 'zset' and holdsType ~= 'none' then return {'ERR', 'holds_type'} end
  local orderType = redis.call('TYPE', orderKey).ok
  if orderType == 'none' then
    redis.call('ZREM', holdsKey, orderId)
    return {'RESOLVED'}
  end
  if orderType ~= 'string' then return {'ERR', 'order_type'} end
  local ok, order = pcall(cjson.decode, redis.call('GET', orderKey))
  if not ok or type(order) ~= 'table' then return {'ERR', 'bad_order_json'} end
  if order['status'] ~= 'pending' then
    redis.call('ZREM', holdsKey, orderId)
    return {'RESOLVED'}
  end
  local pid = order['paymentId']
  if requireNoPaymentId and pid ~= nil and pid ~= cjson.null and pid ~= '' then
    return {'HAS_PAYMENT'}
  end
end

-- Writes only below this line; every key was type-checked above.
redis.call('SET', flagKey, flagJson)
redis.call('ZADD', indexKey, at, orderId)
if mode == 'dequeue' then
  redis.call('ZREM', holdsKey, orderId)
end
return {'FLAGGED'}
`;

// read-only availability resolver. Counter present -> return it. Counter
// absent + init record present -> LOST (initialized before, counter now
// missing: refuse, no mutation). Neither present -> genuinely new tier,
// so seed the init record and counter together and return the total.
//
// Returns: {'OK', remaining} | {'LOST'} | {'ERR', reason}
const READ_AVAILABILITY_SCRIPT = `
local invKey = KEYS[1]
local initKey = KEYS[2]
local total = tonumber(ARGV[1])
local maxInv = tonumber(ARGV[2])
if not maxInv or maxInv < 1 then return {'ERR', 'bad_max'} end
if not total or total ~= math.floor(total) or total < 0 or total > maxInv then
  return {'ERR', 'bad_total'}
end

local invType = redis.call('TYPE', invKey).ok
if invType ~= 'string' and invType ~= 'none' then return {'ERR', 'inv_type'} end

if invType == 'string' then
  -- Reject (don't normalize) a counter that isn't a canonical non-negative
  -- integer string in range, e.g. "1.5", "1.0", "1e2", a leading-zero form
  -- like "01", or an overflow. "Canonical" is exactly "0", or 1-9 then any
  -- digits (Lua patterns have no alternation).
  local cs = redis.call('GET', invKey)
  if type(cs) ~= 'string' or not (cs == '0' or string.match(cs, '^[1-9]%d*$')) then
    return {'ERR', 'inv_nan'}
  end
  local v = tonumber(cs)
  if not v or v > maxInv then return {'ERR', 'inv_range'} end
  return {'OK', v}
end

if redis.call('EXISTS', initKey) == 1 then
  return {'LOST'}
end

redis.call('SET', initKey, total)
redis.call('SET', invKey, total)
return {'OK', total}
`;

// Thrown when inventory state cannot be established safely — e.g. a tier
// that was initialized but whose counter is now missing. We surface this
// rather than silently resetting availability to full capacity.
export class InventoryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryStateError";
  }
}

export type ReserveResult =
  | "created"
  | "sold_out"
  | "exists"
  | "conflict"
  | "attempt_exists"
  | "attempt_conflict"
  | "lost"
  | "error";
export type TransitionResult =
  | "applied"
  | "noop"
  | "conflict"
  | "has_payment"
  | "not_found"
  | "error";
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

// Lazy hold expiry. For each expired pending hold, resolve its fate from
// AUTHORITATIVE provider evidence, never from a clock or an HTTP code:
// retrieve the payment, bind it, and apply the single transition its status
// justifies (via the shared policy). A payment still in a cancellable state
// gets ONE bounded cancellation attempt followed by a re-read — a cancel
// 400 / non-success / timeout never itself produces succeeded or released
// (the INV-01 fix). Inconclusive outcomes retain the allocation and are
// flagged for the recovery phase rather than guessed.
//
// Single-flight (reapInFlight) is kept as a per-instance OPTIMISATION so
// one request's concurrent callers (e.g. GA + VIP availability read in
// parallel) share one pass. Correctness does NOT depend on it: every
// release is a guarded atomic pending->terminal transition, so two passes
// (here or on different instances) that both see the same hold apply the
// inventory effect at most once.
let reapInFlight: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Provider-time budget for request-triggered expiry (see the constants for
// the rationale). The budget window is per instance and is SHARED by every
// expiry pass that starts within it, so the several passes one request can
// trigger draw on one budget rather than each getting a fresh one. Only time
// spent inside provider calls is charged; Redis and other overhead are not,
// so this is a provider-work bound, not an end-to-end deadline.
// ---------------------------------------------------------------------------

interface ProviderBudgetWindow {
  startedAt: number;
  spentMs: number;
}

let providerBudgetWindow: ProviderBudgetWindow | null = null;

function expiryProviderBudgetMs(): number {
  const raw = Number(process.env.HOLD_EXPIRY_PROVIDER_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : HOLD_EXPIRY_PROVIDER_BUDGET_MS;
}

function currentBudgetWindow(now: number): ProviderBudgetWindow {
  if (
    !providerBudgetWindow ||
    now - providerBudgetWindow.startedAt >= HOLD_EXPIRY_BUDGET_WINDOW_MS
  ) {
    providerBudgetWindow = { startedAt: now, spentMs: 0 };
  }
  return providerBudgetWindow;
}

// Starts a fresh budget window. Exposed for tests (and any future operator
// tooling); the application itself never calls it.
export function resetExpiryBudgetWindow(): void {
  providerBudgetWindow = null;
}

// Runs one provider call under the remaining budget: refuses to START it
// when fewer than HOLD_EXPIRY_MIN_CALL_MS remain, otherwise caps its timeout
// at the remaining budget and charges the wall time it actually took.
async function withProviderBudget<T>(
  call: (timeoutMs: number) => Promise<T>
): Promise<{ started: false } | { started: true; value: T }> {
  const window = currentBudgetWindow(Date.now());
  const remaining = expiryProviderBudgetMs() - window.spentMs;
  if (remaining < HOLD_EXPIRY_MIN_CALL_MS) return { started: false };
  const startedAt = Date.now();
  try {
    return { started: true, value: await call(remaining) };
  } finally {
    window.spentMs += Date.now() - startedAt;
  }
}

async function reapExpiredHolds(): Promise<void> {
  if (reapInFlight) return reapInFlight;

  reapInFlight = (async () => {
    const now = Date.now();
    // Bounded batch, oldest-expired first. A large backlog or a provider
    // outage is worked off across many passes; one request never processes
    // every expired order.
    const expiredIds = await redis.zrange<string[]>(PENDING_HOLDS_KEY, "-inf", now, {
      byScore: true,
      offset: 0,
      count: HOLD_EXPIRY_BATCH_SIZE,
    });

    for (const orderId of expiredIds) {
      let outcome: HoldOutcome;
      try {
        outcome = await reconcileExpiredHold(orderId);
      } catch (err) {
        // A failure part-way through one hold (Redis unavailable, or the
        // reconciliation flag could not be recorded) is NOT treated as
        // handled: a hold only ever leaves the pending index together with
        // its recorded flag, so it stays discoverable there and a later pass
        // retries it. Logged by error class only: an error message can embed
        // Redis command arguments (an order JSON with its owner hash).
        logEvent("error", "expiry.hold_left_pending", { orderId, errorKind: errorKind(err) });
        continue;
      }
      // Budget exhausted: start no more provider work this pass. Every hold
      // not yet reached stays in the index, untouched, for a later pass.
      if (outcome === "budget_exhausted") break;
    }
  })();

  try {
    await reapInFlight;
  } finally {
    reapInFlight = null;
  }
}

type HoldOutcome = "continue" | "budget_exhausted";

// Resolves one expired hold, or leaves it safely retained. Every exit is one
// of: resolved by an atomic transition (which removes the hold); moved to the
// reconciliation index atomically with its flag (retainAndDequeue); kept in
// the pending index for a later pass (deferHold, or untouched when the
// budget ran out). Nothing here releases inventory without authoritative,
// bound provider evidence.
async function reconcileExpiredHold(orderId: string): Promise<HoldOutcome> {
  const order = await readOrder(orderId);
  if (!order || order.status !== "pending") {
    // Already resolved elsewhere (a webhook, another pass, or a stale
    // entry) — drop it so we stop re-checking.
    await redis.zrem(PENDING_HOLDS_KEY, orderId);
    return "continue";
  }

  // (A) No attached payment id. Absence of a payment id — or of the
  // payment-attempt marker — is NOT evidence that no provider payment
  // exists: creation may have succeeded before attachment failed, legacy
  // orders never had the marker, and attach-then-clear can land between our
  // read and our action. So this order is never released here: it is
  // retained and flagged. The marker only refines the (diagnostic) reason.
  // The dequeue re-checks inside Redis that the order is still pending with
  // no payment id, so a payment id attached after our read leaves the hold
  // in the index (HAS_PAYMENT) for a later pass to reconcile with the
  // provider. Lazy expiry cannot produce new evidence for a payment-less
  // order, so on success it moves to the reconciliation index; orphan
  // recovery is deferred.
  if (!order.paymentId) {
    const attempted = await hasPaymentAttempt(orderId);
    await retainAndDequeue(
      orderId,
      attempted ? "no_payment_id_attempt_marked" : "no_payment_id_unresolved",
      true
    );
    return "continue";
  }
  const paymentId = order.paymentId;

  // (B) Reconcile against authoritative provider state.
  const firstRead = await withProviderBudget((timeoutMs) =>
    retrievePayment(paymentId, { timeoutMs })
  );
  if (!firstRead.started) return "budget_exhausted";
  const first = await reconcileKnownOrder(order, firstRead.value);
  if (first.result === "paid" || first.result === "released") return "continue";
  if (first.result === "transient") {
    // Provider unavailable: keep for a later pass, behind earlier holds.
    await deferHold(orderId);
    return "continue";
  }
  if (first.result === "retained" || first.result === "conflict") {
    // applyDecision already recorded the flag (and index entry).
    await redis.zrem(PENDING_HOLDS_KEY, orderId);
    return "continue";
  }
  if (first.result !== "not_final") {
    // mismatch / unknown_payment / not_ready for an order that has a payment
    // id: an anomaly. Retain, flag, and move to the reconciliation index.
    await retainAndDequeue(orderId, reconcileResultReason(first));
    return "continue";
  }

  // (C) Still non-terminal: attempt ONE cancellation, then re-read. The
  // cancel response never decides the outcome; only the authoritative
  // re-read does.
  const cancel = await withProviderBudget((timeoutMs) =>
    hyperswitchFetch(
      `/payments/${paymentId}/cancel`,
      { method: "POST", body: JSON.stringify({ cancellation_reason: "hold_expired" }) },
      { timeoutMs }
    ).then(
      () => "responded" as const,
      () => "unknown" as const
    )
  );
  if (!cancel.started) return "budget_exhausted";
  if (cancel.value === "unknown") {
    // Timeout / transport failure: we cannot tell whether the provider
    // received or processed the cancellation. Retain the allocation, record
    // it, and keep the hold eligible for a later lazy pass (a later read CAN
    // produce new evidence). If recording fails this throws before the
    // hold is touched, so it stays in the index as-is.
    await flagForReconciliation(orderId, "cancel_outcome_unknown");
    await deferHold(orderId);
    return "continue";
  }

  const secondRead = await withProviderBudget((timeoutMs) =>
    retrievePayment(paymentId, { timeoutMs })
  );
  if (!secondRead.started) {
    // Cancellation issued, but no budget left to confirm its effect.
    await flagForReconciliation(orderId, "cancel_issued_retrieve_deferred");
    await deferHold(orderId);
    return "budget_exhausted";
  }
  const second = await reconcileKnownOrder(order, secondRead.value);
  if (second.result === "paid" || second.result === "released") return "continue";
  if (second.result === "transient") {
    // Cancellation issued but the resulting state cannot be confirmed.
    await flagForReconciliation(orderId, "cancel_issued_retrieve_inconclusive");
    await deferHold(orderId);
    return "continue";
  }
  if (second.result === "retained" || second.result === "conflict") {
    await redis.zrem(PENDING_HOLDS_KEY, orderId);
    return "continue";
  }
  // Still non-terminal (or anomalous) after a cancellation: retain, flag,
  // and move to the reconciliation index.
  await retainAndDequeue(
    orderId,
    second.result === "not_final" ? "cancel_then_not_final" : reconcileResultReason(second)
  );
  return "continue";
}

export async function getRemainingInventory(
  eventId: string,
  tierName: string,
  totalInventory: number
): Promise<number> {
  await reapExpiredHolds();
  const result = await evalScript(
    READ_AVAILABILITY_SCRIPT,
    [inventoryKey(eventId, tierName), inventoryInitKey(eventId, tierName)],
    [String(totalInventory), String(MAX_INVENTORY)]
  );
  const code = resultCode(result);
  if (code === "LOST") {
    throw new InventoryStateError(
      `inventory counter for ${eventId}:${tierName} is missing but the tier was initialized; ` +
        `refusing to reset availability to full`
    );
  }
  if (code !== "OK") {
    throw new InventoryStateError(
      `inventory state for ${eventId}:${tierName} could not be read (${String(result[1] ?? code)})`
    );
  }
  const remaining = Number(result[1]);
  // Clamped on both ends for DISPLAY only: never below 0, never above
  // totalInventory. This is a read-time presentation safety net, not
  // evidence that accounting is correct — the integration tests assert
  // the RAW counter, never this clamped value. It does NOT paper over a
  // missing counter: that case throws above rather than clamping.
  return Math.min(totalInventory, Math.max(0, remaining));
}

// Atomically reserve inventory AND persist the order and its hold
// together (see RESERVE_AND_CREATE_SCRIPT). Either all of it happens or
// none of it does, closing the old gap where a decrement could land with
// no recoverable order to reap. Resubmitting the SAME order id never
// decrements twice or overwrites the stored order: a matching booking
// returns "exists" (the order already exists, with whatever status it has
// now), a different booking under the same id returns "conflict", and a
// tier whose counter was lost returns "lost" — all without mutation.
// This is internal-operation replay safety, NOT client checkout
// idempotency (a fresh HTTP checkout still mints a new order id).
//
// The order must carry its guest owner (order.ownerHash), its booking
// attempt (attemptId), and its provider payment identity (paymentRequestId).
// Without them the script refuses ("error"); a replay by a different owner
// is "conflict"; an attempt already bound to another order is
// "attempt_exists" / "attempt_conflict" (see reserveBookingAttempt for the
// bound order's id).
export async function reserveAndCreateOrder(
  order: Order,
  totalInventory: number
): Promise<ReserveResult> {
  return (await reserveBookingAttempt(order, totalInventory)).result;
}

export interface ReserveOutcome {
  result: ReserveResult;
  // For attempt_exists / attempt_conflict: the order the attempt is bound to.
  boundOrderId?: string;
}

export async function reserveBookingAttempt(
  order: Order,
  totalInventory: number
): Promise<ReserveOutcome> {
  await reapExpiredHolds();
  const result = await evalScript(
    RESERVE_AND_CREATE_SCRIPT,
    [
      inventoryKey(order.eventId, order.tierName),
      orderKey(order.id),
      PENDING_HOLDS_KEY,
      inventoryInitKey(order.eventId, order.tierName),
      guestOrdersKey(order.ownerHash ?? ""),
      bookingAttemptKey(order.ownerHash ?? "", order.attemptId ?? ""),
    ],
    [JSON.stringify(order), String(totalInventory), String(MAX_INVENTORY)]
  );
  const code = resultCode(result);
  if (code === "OK") return { result: "created" };
  if (code === "SOLD_OUT") return { result: "sold_out" };
  if (code === "EXISTS") return { result: "exists" };
  if (code === "CONFLICT") return { result: "conflict" };
  if (code === "ATTEMPT_EXISTS") return { result: "attempt_exists", boundOrderId: String(result[1]) };
  if (code === "ATTEMPT_CONFLICT") {
    return { result: "attempt_conflict", boundOrderId: String(result[1]) };
  }
  if (code === "LOST") return { result: "lost" };
  return { result: "error" };
}

// The order an owner's booking attempt is bound to, if any. A plain read for
// the order route's pre-check; the reserve script re-checks atomically.
export async function peekBookingAttempt(
  ownerHash: string,
  attemptId: string
): Promise<string | null> {
  const record = await redis.get<{ orderId?: unknown }>(bookingAttemptKey(ownerHash, attemptId));
  return record && typeof record.orderId === "string" ? record.orderId : null;
}

// Guarded compare-and-set status transition with its inventory effect.
// Exposed for callers that need the precise outcome (and for tests);
// updateOrderStatus and markOrderRefunded wrap it with fixed semantics.
export async function transitionOrder(
  id: string,
  from: OrderStatus,
  to: OrderStatus,
  releasesInventory: boolean,
  options: { requireNoPaymentId?: boolean } = {}
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
    [
      id,
      from,
      to,
      releasesInventory ? "1" : "0",
      String(MAX_INVENTORY),
      options.requireNoPaymentId ? "1" : "0",
    ]
  );
  const code = resultCode(result);
  if (code === "OK") return "applied";
  if (code === "NOOP") return "noop";
  if (code === "CONFLICT") return "conflict";
  if (code === "HAS_PAYMENT") return "has_payment";
  if (code === "NOT_FOUND") return "not_found";
  return "error";
}

// Statuses whose transition from pending releases the held inventory
// back to the tier. succeeded keeps the seat.
const RELEASING_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["failed", "expired"]);

// Fixed-semantics pending -> terminal transition, used by the order
// route's own provider-failure path. (Provider-driven outcomes — webhook,
// payment-status read, expiry — go through the shared reconciliation in
// applyDecision, which calls transitionOrder directly.) Atomic and
// idempotent by construction: concurrent or repeated callers resolve to a
// single applied transition; the others see a non-pending status and
// no-op, never a second inventory release.
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

// Reads the stored order WITHOUT getOrder's lazy-reap side effect. The
// webhook handler uses this: authenticating a delivery and binding a
// payment to its order must not incidentally trigger unrelated hold
// expiry/cancellation work (which reapExpiredHolds does, and which can
// itself call the provider). Returns the order as-is, or undefined if the
// key is absent.
export async function peekOrder(id: string): Promise<Order | undefined> {
  return readOrder(id);
}

// The newest orders created by one guest, at most `limit`, as stored. Reads
// only that guest's index and those order keys: no reap, no provider call.
// Callers still check ownership on every returned order (defence in depth),
// and an index entry whose order has gone is skipped.
export async function listGuestOrders(ownerHash: string, limit: number): Promise<Order[]> {
  const ids = await redis.zrange<string[]>(guestOrdersKey(ownerHash), 0, limit - 1, { rev: true });
  if (ids.length === 0) return [];
  const orders = await redis.mget<(Order | null)[]>(...ids.map(orderKey));
  return orders.filter((o): o is Order => o !== null && typeof o === "object");
}

// ---------------------------------------------------------------------------
// Webhook-delivery dedup marker. A bounded-TTL key set ONLY after a webhook
// delivery's business outcome is durably recorded. isWebhookEventProcessed
// lets a sequential redelivery of an already-handled event skip a duplicate
// provider read; it is NOT what prevents duplicate business effects (the
// atomic transitions are — a concurrent duplicate that races past this
// check still no-ops at the transition). Keep this a plain marker: not a
// lock, not a queue.
// ---------------------------------------------------------------------------
function webhookEventKey(eventId: string) {
  return `webhook_event:${eventId}`;
}

export async function isWebhookEventProcessed(eventId: string): Promise<boolean> {
  return (await redis.exists(webhookEventKey(eventId))) === 1;
}

export async function markWebhookEventProcessed(eventId: string): Promise<void> {
  await redis.set(webhookEventKey(eventId), "1", { ex: WEBHOOK_EVENT_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// Reconciliation flag + payment-attempt marker.
// ---------------------------------------------------------------------------

export interface ReconcileFlag {
  reason: string; // bounded, non-sensitive slug
  at: number; // epoch ms
}

type RecordOutcome = "FLAGGED" | "RESOLVED" | "HAS_PAYMENT";

// Writes a reconciliation flag (bounded, non-sensitive reason + timestamp)
// and its reconcile_needed index entry atomically; in 'dequeue' mode also
// removes the hold from the pending index in the same step (see
// RECORD_RECONCILE_SCRIPT). Never rewrites the order and never changes
// inventory. Throws if the record could not be written, so a caller can
// never mistake a failed record for a handled order.
async function recordReconciliation(
  orderId: string,
  reason: string,
  mode: "record" | "dequeue",
  requireNoPaymentId = false
): Promise<RecordOutcome> {
  const at = Date.now();
  const flag = JSON.stringify({ reason: reason.slice(0, 64), at });
  const result = await evalScript(
    RECORD_RECONCILE_SCRIPT,
    [orderKey(orderId), PENDING_HOLDS_KEY, reconcileKey(orderId), RECONCILE_INDEX_KEY],
    [orderId, flag, String(at), mode, requireNoPaymentId ? "1" : "0"]
  );
  const code = resultCode(result);
  if (code === "FLAGGED" || code === "RESOLVED" || code === "HAS_PAYMENT") return code;
  throw new Error(`reconciliation record failed (${String(result[1] ?? code)})`);
}

// Records that an order needs later reconciliation (a failed-but-retained
// payment, an inconclusive cancellation, a late conflict). Leaves the
// pending-holds index untouched.
export async function flagForReconciliation(orderId: string, reason: string): Promise<void> {
  await recordReconciliation(orderId, reason, "record");
}

// Retains the allocation, records the flag, and moves the hold from the
// pending index to the reconciliation index — atomically, and only while
// the order is still pending (and, if requested, still has no payment id).
async function retainAndDequeue(
  orderId: string,
  reason: string,
  requireNoPaymentId = false
): Promise<RecordOutcome> {
  return recordReconciliation(orderId, reason, "dequeue", requireNoPaymentId);
}

// Keeps a hold eligible for a later lazy-expiry pass but moves it behind
// holds that expired earlier (re-scored to now), so one hold that keeps
// failing — e.g. a payment read that always times out and would otherwise
// consume the whole budget — cannot starve the rest of the queue. XX: never
// re-adds a hold that a concurrent transition has already removed.
async function deferHold(orderId: string): Promise<void> {
  await redis.zadd(PENDING_HOLDS_KEY, { xx: true }, { score: Date.now(), member: orderId });
}

export async function getReconciliationFlag(orderId: string): Promise<ReconcileFlag | null> {
  return (await redis.get<ReconcileFlag>(reconcileKey(orderId))) ?? null;
}

// Set just before a provider payment is created, cleared once its id is
// attached. DIAGNOSTIC ONLY: expiry records whether it was present in the
// flag reason, but its absence is never treated as proof that no payment
// exists (legacy orders never had it, and attach-then-clear can race with
// an expiry read).
export async function markPaymentAttempt(orderId: string): Promise<void> {
  await redis.set(paymentAttemptKey(orderId), "1", { ex: PAYMENT_ATTEMPT_TTL_SECONDS });
}

export async function clearPaymentAttempt(orderId: string): Promise<void> {
  await redis.del(paymentAttemptKey(orderId));
}

// Claims the payment-creation lease for an order; returns a token to release
// it with, or null when another request holds it.
export async function claimPaymentLease(orderId: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis.set(paymentLeaseKey(orderId), token, { nx: true, px: ttlMs });
  return ok === "OK" ? token : null;
}

// Releases the lease only if this token still holds it (a lapsed lease
// re-claimed by another request is left alone).
export async function releasePaymentLease(orderId: string, token: string): Promise<void> {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    [paymentLeaseKey(orderId)],
    [token]
  );
}

async function hasPaymentAttempt(orderId: string): Promise<boolean> {
  return (await redis.exists(paymentAttemptKey(orderId))) === 1;
}

// ---------------------------------------------------------------------------
// Shared reconciliation: map AUTHORITATIVE provider state onto the local
// order using the same binding (payment-policy) and the same atomic
// transitions on every path (webhook, payment-status read, expiry). No HTTP
// response code, event name, or metadata alone ever drives an outcome.
// ---------------------------------------------------------------------------

export type ReconcileResult =
  | { result: "paid" }
  | { result: "released" }
  | { result: "retained"; reason: string }
  | { result: "not_final"; reason: string }
  | { result: "conflict"; current: OrderStatus }
  | { result: "not_ready"; reason: string }
  | { result: "mismatch"; reason: string }
  | { result: "transient"; reason: string }
  | { result: "unknown_payment" };

export function reconcileResultReason(r: ReconcileResult): string {
  if (r.result === "unknown_payment") return "provider_unknown_payment";
  if (r.result === "conflict") return `conflict_over_${r.current}`;
  if ("reason" in r && r.reason) return r.reason;
  return r.result;
}

// Applies the single transition a decision justifies, atomically, and
// records reconciliation for the outcomes that leave the order unresolved
// without a transition (a retained failed payment) or that collide with an
// already-terminal order (a late conflict). Uses readOrder (no reap).
async function applyDecision(order: Order, decision: Decision): Promise<ReconcileResult> {
  if (decision.action === "retain") {
    await flagForReconciliation(order.id, decision.reason);
    return { result: "retained", reason: decision.reason };
  }
  if (decision.action === "pending") {
    // Non-terminal: no guessed terminal outcome. Caller decides whether to
    // retry (webhook / status) or attempt cancellation (expiry).
    return { result: "not_final", reason: decision.reason };
  }

  const tr = await transitionOrder(order.id, "pending", decision.to, decision.release);
  if (tr === "applied" || tr === "noop") {
    return { result: decision.action === "succeed" ? "paid" : "released" };
  }
  if (tr === "conflict") {
    // Late / conflicting evidence: the order is already in a different
    // terminal state. Do NOT overwrite it; record the conflict.
    const current = (await readOrder(order.id))?.status ?? order.status;
    await flagForReconciliation(order.id, `conflict_${decision.to}_over_${current}`);
    return { result: "conflict", current };
  }
  // not_found / error — the order vanished or a data error; retryable.
  return { result: "transient", reason: `transition_${tr}` };
}

// Reconcile a KNOWN, already-retrieved provider payment against its order.
// Used by the webhook and the payment-status read (both already hold `pp`).
export async function reconcileRetrievedPayment(
  pp: ProviderPayment,
  requestedPaymentId: string
): Promise<ReconcileResult> {
  const orderId = typeof pp.metadata?.orderId === "string" ? pp.metadata.orderId : "";
  if (!orderId) return { result: "mismatch", reason: "no_order_association" };
  const order = await readOrder(orderId); // no reap
  if (!order) return { result: "mismatch", reason: "unknown_order" };
  const bound = bindPaymentToOrder(order, pp, requestedPaymentId);
  if (bound.kind === "retry") return { result: "not_ready", reason: bound.reason };
  if (bound.kind === "reject") return { result: "mismatch", reason: bound.reason };
  return applyDecision(order, decideFromStatus(pp.status));
}

// Retrieve + reconcile by payment id. Used by the webhook (which has only a
// payment id and does not need the payment object afterwards).
export async function reconcilePaymentById(paymentId: string): Promise<ReconcileResult> {
  const retrieved = await retrievePayment(paymentId);
  if (!retrieved.ok) {
    return retrieved.category === "not_found"
      ? { result: "unknown_payment" }
      : { result: "transient", reason: "provider_unavailable" };
  }
  return reconcileRetrievedPayment(retrieved.payment, paymentId);
}

// Reconcile a KNOWN order (expiry path) against a retrieval of its attached
// payment id: bind and apply. The retrieval is done by the caller so expiry
// can charge it to its provider-time budget.
async function reconcileKnownOrder(
  order: Order,
  retrieved: RetrievePaymentResult
): Promise<ReconcileResult> {
  const paymentId = order.paymentId;
  if (!paymentId) return { result: "not_ready", reason: "no_payment_id" };
  if (!retrieved.ok) {
    return retrieved.category === "not_found"
      ? { result: "unknown_payment" }
      : { result: "transient", reason: "provider_unavailable" };
  }
  const bound = bindPaymentToOrder(order, retrieved.payment, paymentId);
  if (bound.kind === "reject") return { result: "mismatch", reason: bound.reason };
  if (bound.kind === "retry") return { result: "not_ready", reason: bound.reason };
  return applyDecision(order, decideFromStatus(retrieved.payment.status));
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
