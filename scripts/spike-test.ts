// Fires N concurrent order requests at one event/tier to demonstrate —
// not just assert — that reserveAndCreateOrder's atomic Redis script
// (lib/store.ts) prevents overselling under real concurrency. This is
// the same test that was originally run by hand in a terminal during
// the move to Redis (15 curl requests backgrounded against 10 VIP
// tickets), formalized here so it's repeatable. See the README's
// "Spike test" section for how to run this and what the output means.
//
// Requires the dev server running (npm run dev) in another terminal.
//
// Usage (from the project root):
//   npx tsx scripts/spike-test.ts [--event=<id>] [--tier=GA|VIP]
//     [--requests=<n>] [--quantity=<n>] [--base-url=<url>]

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { events } from "../lib/events";

// Load .env.local manually — this runs as a standalone script outside
// Next's own env loading, and pulling in the dotenv package just for
// this felt like more dependency than the problem needs.
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key in process.env) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

function parseArgs() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key && value !== undefined) args.set(key, value);
  }

  return {
    eventId: args.get("event") ?? "midnight-parade",
    tierName: args.get("tier") ?? "VIP",
    requestCount: Number(args.get("requests") ?? 15),
    quantity: Number(args.get("quantity") ?? 1),
    baseUrl: args.get("base-url") ?? "http://localhost:3000",
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Safety guard: this script fires many real order requests and reads the
// inventory counter straight from Redis. It must never be aimed at a
// deployed app or a hosted database. Refuse any non-loopback target —
// both the HTTP base URL and the Redis URL the Upstash client will use —
// before a single request or Redis command runs. Exported so it can be
// unit-tested with fixtures instead of by contacting a host.
export function assertLocalSpikeTarget(opts: {
  baseUrl: string;
  redisUrl: string | undefined;
}): void {
  const baseHost = hostOf(opts.baseUrl);
  if (!baseHost || !LOOPBACK_HOSTS.has(baseHost)) {
    throw new Error(
      `spike-test refuses a non-local --base-url (${opts.baseUrl}). ` +
        `Point it at a local dev server only.`
    );
  }

  const redisHost = hostOf(opts.redisUrl);
  if (!opts.redisUrl) {
    throw new Error(
      "spike-test found no UPSTASH_REDIS_REST_URL. Run it only against a local test Redis."
    );
  }
  if (/\.upstash\.io$/i.test(redisHost ?? "") || !redisHost || !LOOPBACK_HOSTS.has(redisHost)) {
    throw new Error(
      `spike-test refuses a non-local Redis target (${opts.redisUrl}). ` +
        `It would mutate that database. Use a local test Redis only.`
    );
  }
}

async function main() {
  const { eventId, tierName, requestCount, quantity, baseUrl } = parseArgs();

  // Refuse remote targets before touching Redis or firing any request.
  assertLocalSpikeTarget({
    baseUrl,
    redisUrl: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
  });

  const event = events.find((e) => e.id === eventId);
  const tier = event?.tiers.find((t) => t.name === tierName);
  if (!event || !tier) {
    console.error(`Unknown event/tier: ${eventId}/${tierName}`);
    process.exit(1);
  }

  const redis = Redis.fromEnv();
  const inventoryKey = `inventory:${eventId}:${tierName}`;
  const before = (await redis.get<number>(inventoryKey)) ?? tier.totalInventory;

  console.log(
    `Firing ${requestCount} concurrent requests for ${quantity}x ${tierName} @ ${event.name}`
  );
  console.log(`Available before: ${before} (tier total: ${tier.totalInventory})\n`);

  // Booking needs what a browser sends (Phase 1B.4–1B.5): an established
  // guest session cookie, the app's own Origin header, and a booking attempt
  // id. Each request below is a separate attempt, i.e. a separate buyer
  // decision, so they compete for inventory exactly as distinct bookings do.
  // The server must run with CONTICX_MODE=full and APP_ORIGIN set to this
  // base URL's origin.
  const origin = new URL(baseUrl).origin;
  const session = await fetch(`${baseUrl}/api/guest-session`, { method: "POST", headers: { Origin: origin } });
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!session.ok || !cookie) {
    console.error(
      `Could not start a guest session (HTTP ${session.status}). Is the app running with ` +
        `CONTICX_MODE=full and APP_ORIGIN=${origin}?`
    );
    process.exit(1);
  }

  const statuses = await Promise.all(
    Array.from({ length: requestCount }, () =>
      fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
        body: JSON.stringify({ eventId, tierName, quantity, attemptId: randomUUID() }),
      })
        .then((res) => res.status)
        .catch(() => 0) // 0 = request itself failed (e.g. dev server not running)
    )
  );

  const succeeded = statuses.filter((status) => status === 200).length;
  const rejected = statuses.filter((status) => status === 400).length;
  const errored = statuses.length - succeeded - rejected;
  const after = (await redis.get<number>(inventoryKey)) ?? tier.totalInventory;
  const expectedAfter = before - succeeded * quantity;

  console.log("Results:");
  console.log(`  succeeded: ${succeeded}`);
  console.log(`  rejected (sold out): ${rejected}`);
  if (errored > 0) console.log(`  errored (request-level, not oversell-related): ${errored}`);
  console.log(`  inventory: ${before} -> ${after} (expected ${expectedAfter})`);

  if (after === expectedAfter && after >= 0) {
    console.log("\nOK — inventory accounting is exact, no oversell.");
  } else {
    console.log(
      `\nMISMATCH — expected ${expectedAfter}, got ${after}. Investigate reserveAndCreateOrder in lib/store.ts.`
    );
    process.exit(1);
  }
}

// Only run when executed directly (npm run spike-test), not when
// imported by a test that just wants to exercise the safety guard.
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main();
}
