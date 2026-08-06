// Fires N concurrent order requests at one event/tier to demonstrate —
// not just assert — that reserveInventory's atomic Redis DECRBY
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

async function main() {
  const { eventId, tierName, requestCount, quantity, baseUrl } = parseArgs();

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

  const statuses = await Promise.all(
    Array.from({ length: requestCount }, () =>
      fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, tierName, quantity }),
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
      `\nMISMATCH — expected ${expectedAfter}, got ${after}. Investigate reserveInventory in lib/store.ts.`
    );
    process.exit(1);
  }
}

main();
