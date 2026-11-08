// Operator report for the public sandbox demo's Redis namespace.
//
// Read-only by default: lists pending holds, orders flagged for
// reconciliation (with their current status and reason), order counts by
// status, remaining inventory per tier, and the usage-limit counters. It never
// resets, deletes, or edits data.
//
// --recheck re-runs the app's own provider reconciliation for flagged orders
// that have an attached payment. It is the same evidence-based policy the
// webhook and status paths use — a seat is released only on an authoritative
// cancelled / expired / final-failed status, never on a timeout — and it is
// refused unless the provider settings are a Hyperswitch sandbox.
//
// Usage (from the project root), with the deployment's settings in the
// environment — this script does NOT read .env.local, so it cannot silently
// point at a different database:
//   CONTICX_REDIS_PREFIX=<namespace> UPSTASH_REDIS_REST_URL=... \
//   UPSTASH_REDIS_REST_TOKEN=... npx tsx scripts/demo-ops.ts [--recheck]
// --recheck additionally needs HYPERSWITCH_BASE_URL, HYPERSWITCH_API_KEY and
// NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY. See docs/operations.md.

import { Redis } from "@upstash/redis";
import { events } from "../lib/events";
import { redisKeyPrefix } from "../lib/redis-keys";
import type { Order } from "../lib/types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const recheck = process.argv.includes("--recheck");
if (!process.env.CONTICX_REDIS_PREFIX) fail("Set CONTICX_REDIS_PREFIX to the demo's namespace.");
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  fail("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
}
const ns = redisKeyPrefix(); // validates the prefix; "<prefix>:"
const redis = Redis.fromEnv();

function short(id: string): string {
  return id.slice(0, 8);
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 0 ? `${Math.floor(s / 60)}m${s % 60}s` : `-${Math.floor(-s / 60)}m${-s % 60}s`;
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, batch]: [string | number, string[]] = await redis.scan(cursor, { match: pattern, count: 500 });
    keys.push(...batch);
    cursor = next;
  } while (String(cursor) !== "0");
  return keys;
}

async function main() {
  const now = Date.now();
  console.log(`Namespace: ${ns.slice(0, -1)}`);

  const orderKeys = await scanKeys(`${ns}order:*`);
  const orders = (await Promise.all(orderKeys.map((k) => redis.get<Order>(k)))).filter(Boolean) as Order[];
  const byStatus = new Map<string, number>();
  for (const o of orders) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
  console.log(`\nOrders: ${orders.length}  ${[...byStatus].map(([s, n]) => `${s}=${n}`).join("  ")}`);

  const holds = await redis.zrange<string[]>(`${ns}pending_holds`, 0, -1, { withScores: true });
  console.log(`\nPending holds: ${holds.length / 2}`);
  for (let i = 0; i < holds.length; i += 2) {
    const id = String(holds[i]);
    const expiresAt = Number(holds[i + 1]);
    const o = orders.find((x) => x.id === id);
    console.log(
      `  ${short(id)}  ${o ? `${o.eventId}/${o.tierName} x${o.quantity}` : "?"}  ` +
        `${expiresAt <= now ? `expired ${ago(now - expiresAt)} ago` : `expires in ${ago(expiresAt - now)}`}  ` +
        `payment ${o?.paymentId ? "attached" : "not attached"}`
    );
  }

  const flagged = await redis.zrange<string[]>(`${ns}reconcile_needed`, 0, -1);
  console.log(`\nFlagged for reconciliation: ${flagged.length}`);
  for (const id of flagged) {
    const flag = await redis.get<{ reason?: string; at?: number }>(`${ns}reconcile:${id}`);
    const o = orders.find((x) => x.id === id);
    console.log(
      `  ${short(id)}  status=${o?.status ?? "missing"}  reason=${flag?.reason ?? "?"}  ` +
        `flagged ${flag?.at ? `${ago(now - flag.at)} ago` : "?"}  payment ${o?.paymentId ? "attached" : "not attached"}`
    );
  }

  console.log("\nInventory (remaining / capacity):");
  for (const event of events) {
    for (const tier of event.tiers) {
      const left = await redis.get<number>(`${ns}inventory:${event.id}:${tier.name}`);
      console.log(`  ${event.id}/${tier.name}  ${left ?? `${tier.totalInventory} (not yet initialized)`} / ${tier.totalInventory}`);
    }
  }

  const rateKeys = await scanKeys(`${ns}rate:*:all`);
  console.log("\nOverall usage counters (current window):");
  for (const key of rateKeys) {
    const [value, ttl] = await Promise.all([redis.get<number>(key), redis.pttl(key)]);
    console.log(`  ${key.slice(ns.length)}  ${value}  resets in ${ago(ttl)}`);
  }

  if (!recheck) return;
  const { sandboxPaymentsConfigured } = await import("../lib/app-mode");
  if (!sandboxPaymentsConfigured()) fail("\n--recheck refused: provider settings are not a Hyperswitch sandbox.");
  const { reconcilePaymentById, reconcileResultReason } = await import("../lib/store");
  console.log("\nRe-checking flagged orders with the provider:");
  for (const id of flagged) {
    const o = orders.find((x) => x.id === id);
    if (!o?.paymentId || o.status !== "pending") continue;
    const result = await reconcilePaymentById(o.paymentId);
    console.log(`  ${short(id)}  ${result.result} (${reconcileResultReason(result)})`);
  }
}

main().catch((err) => fail(`demo-ops failed: ${err instanceof Error ? err.name : "error"}`));
