import { describe, expect, it } from "vitest";
import { makeTestRedis } from "../helpers/redis";

// T1A-04. Confirms the local serverless-redis-http adapter supports,
// through the real @upstash/redis client, every command the current
// application uses AND the Lua execution paths the Phase 1B transition
// engine will rely on. Passing here proves the harness can exercise
// those paths locally; it does NOT prove parity with hosted Upstash
// (see docs/testing.md "Emulator limitations").

describe("local Redis adapter (serverless-redis-http)", () => {
  it("supports the commands the app uses today", async () => {
    const r = makeTestRedis();

    // SETNX seed + atomic DECRBY/INCRBY (reserveInventory / release).
    expect(await r.setnx("inventory:e:VIP", 10)).toBe(1);
    expect(await r.setnx("inventory:e:VIP", 999)).toBe(0); // second seed no-ops
    expect(await r.decrby("inventory:e:VIP", 3)).toBe(7);
    expect(await r.incrby("inventory:e:VIP", 1)).toBe(8);

    // JSON value round-trip (orders are stored as JSON objects).
    await r.set("order:abc", { id: "abc", status: "pending", quantity: 2 });
    expect(await r.get("order:abc")).toEqual({ id: "abc", status: "pending", quantity: 2 });

    // Sorted set for pending holds (ZADD / ZRANGE byScore / ZREM).
    await r.zadd("pending_holds", { score: 1000, member: "abc" });
    await r.zadd("pending_holds", { score: 5000, member: "def" });
    expect(await r.zrange<string[]>("pending_holds", "-inf", 2000, { byScore: true })).toEqual([
      "abc",
    ]);
    expect(await r.zrem("pending_holds", "abc")).toBe(1);

    // Demand counter (INCR + EXPIRE).
    expect(await r.incr("demand:e")).toBe(1);
    expect(await r.expire("demand:e", 60)).toBe(1);
  });

  it("supports the Lua paths Phase 1B needs (EVAL, SCRIPT LOAD + EVALSHA)", async () => {
    const r = makeTestRedis();

    const evalResult = await r.eval(
      "redis.call('SET', KEYS[1], ARGV[1]); return redis.call('GET', KEYS[1])",
      ["lua:k"],
      ["lua:v"]
    );
    expect(evalResult).toBe("lua:v");

    const sha = await r.scriptLoad("return tonumber(ARGV[1]) + 1");
    expect(await r.evalsha(sha, [], ["41"])).toBe(42);
  });
});
