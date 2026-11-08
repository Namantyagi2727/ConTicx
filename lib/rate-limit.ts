// Modest usage limits for the public sandbox demo, kept in the same Redis
// (and key namespace) as everything else. Fixed-window counters, checked and
// charged together in one atomic script: a request is admitted only if EVERY
// bucket it touches has room, and a refused request charges nothing.
//
// What is limited, and why:
//   guest sessions  issuing a NEW guest credential, per client address and
//                   overall — stops scripted creation of fresh identities.
//   bookings        starting a NEW booking attempt (a retry of an existing
//                   attempt is never charged, so idempotent retries keep
//                   working), per guest, per client address, and overall —
//                   the overall hourly and daily caps are the demo's usage
//                   bound, and they also bound sandbox provider calls.
//   status checks   the confirmation page's status refresh (each one reads
//                   the provider), per guest and overall.
// Webhooks are never limited: they are authenticated provider deliveries.
//
// Client addresses come from the platform's forwarding header (Vercel sets
// x-forwarded-for itself) and are stored only as a truncated SHA-256 hash.
// Configuration: CONTICX_RATE_LIMITS=off disables every limit (the automated
// tests, which create many bookings on purpose); CONTICX_DEMO_BOOKINGS_PER_HOUR
// overrides the overall hourly booking cap (the daily cap is 5x it).

import { createHash } from "node:crypto";
import { redis } from "./redis";
import { rk } from "./redis-keys";
import { jsonNoStore } from "./order-access";

interface Bucket {
  name: string;
  limit: number;
  windowSeconds: number;
}

const DEFAULT_BOOKINGS_PER_HOUR = 60;

function bookingsPerHour(): number {
  const raw = Number(process.env.CONTICX_DEMO_BOOKINGS_PER_HOUR);
  return Number.isInteger(raw) && raw > 0 && raw <= 10_000 ? raw : DEFAULT_BOOKINGS_PER_HOUR;
}

export function rateLimitsEnabled(): boolean {
  return process.env.CONTICX_RATE_LIMITS !== "off";
}

const SESSION_BUCKETS: Bucket[] = [
  { name: "session_client", limit: 20, windowSeconds: 3600 },
  { name: "session_all", limit: 500, windowSeconds: 3600 },
];

function bookingBuckets(): Bucket[] {
  const perHour = bookingsPerHour();
  return [
    { name: "booking_guest", limit: 6, windowSeconds: 600 },
    { name: "booking_client", limit: 15, windowSeconds: 3600 },
    { name: "booking_all", limit: perHour, windowSeconds: 3600 },
    { name: "booking_all_day", limit: perHour * 5, windowSeconds: 86_400 },
  ];
}

const STATUS_BUCKETS: Bucket[] = [
  { name: "status_guest", limit: 40, windowSeconds: 60 },
  { name: "status_all", limit: 3000, windowSeconds: 3600 },
];

// Check every bucket first; charge all of them only if all have room.
// KEYS[i] is bucket i's counter; ARGV[2i-1] its limit, ARGV[2i] its window
// in ms. Returns {0} when admitted, {i, pttl} for the first full bucket.
const CONSUME_SCRIPT = `
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[2 * i - 1])
  local used = tonumber(redis.call('GET', key) or '0')
  if used >= limit then return {i, redis.call('PTTL', key)} end
end
for i, key in ipairs(KEYS) do
  if redis.call('INCR', key) == 1 then redis.call('PEXPIRE', key, ARGV[2 * i]) end
end
return {0, 0}
`;

export type LimitResult = { ok: true } | { ok: false; bucket: string; retryAfterSeconds: number };

// Buckets are keyed by subject: "all" for the overall bounds, otherwise the
// guest's owner hash or the hashed client address.
async function consume(entries: { bucket: Bucket; subject: string }[]): Promise<LimitResult> {
  if (!rateLimitsEnabled()) return { ok: true };
  const keys = entries.map(({ bucket, subject }) => rk(`rate:${bucket.name}:${subject}`));
  const args = entries.flatMap(({ bucket }) => [String(bucket.limit), String(bucket.windowSeconds * 1000)]);
  const result = (await redis.eval(CONSUME_SCRIPT, keys, args)) as [number, number];
  const index = Number(result?.[0] ?? 0);
  if (index === 0) return { ok: true };
  const entry = entries[index - 1];
  const pttl = Number(result[1]);
  const retryAfterSeconds = pttl > 0 ? Math.ceil(pttl / 1000) : entry.bucket.windowSeconds;
  return { ok: false, bucket: entry.bucket.name, retryAfterSeconds };
}

// A stable, non-reversible label for the requesting client's address.
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(address).digest("hex").slice(0, 32);
}

export function limitNewGuestSession(request: Request): Promise<LimitResult> {
  const client = clientKey(request);
  return consume([
    { bucket: SESSION_BUCKETS[0], subject: client },
    { bucket: SESSION_BUCKETS[1], subject: "all" },
  ]);
}

export function limitNewBooking(request: Request, ownerHash: string): Promise<LimitResult> {
  const [guest, client, all, day] = bookingBuckets();
  return consume([
    { bucket: guest, subject: ownerHash },
    { bucket: client, subject: clientKey(request) },
    { bucket: all, subject: "all" },
    { bucket: day, subject: "all" },
  ]);
}

export function limitStatusCheck(ownerHash: string): Promise<LimitResult> {
  return consume([
    { bucket: STATUS_BUCKETS[0], subject: ownerHash },
    { bucket: STATUS_BUCKETS[1], subject: "all" },
  ]);
}

export function rateLimitedResponse(result: Extract<LimitResult, { ok: false }>) {
  return jsonNoStore(
    {
      code: "rate_limited",
      error: "This demo is busy right now. Please try again in a few minutes.",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    429,
    { "Retry-After": String(result.retryAfterSeconds) }
  );
}
