// A direct Upstash REST client pointed at the local serverless-redis-http
// adapter, used by tests to flush and to inspect raw stored values. It
// talks to the same local instance the application code uses, but is a
// separate client the tests own — the app still builds its own client
// through Redis.fromEnv() in lib/redis.ts, which this never replaces.

import { Redis } from "@upstash/redis";
import { TEST_REDIS_TOKEN, TEST_REDIS_URL } from "../setup/constants";

export function makeTestRedis(): Redis {
  return new Redis({ url: TEST_REDIS_URL, token: TEST_REDIS_TOKEN });
}

export async function flushTestRedis(): Promise<void> {
  await makeTestRedis().flushdb();
}

export async function pingTestRedis(): Promise<boolean> {
  try {
    const pong = await makeTestRedis().ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

// Write an EXACT string value, bypassing the SDK's value serialization,
// so a numeric-looking fixture ("1.5", "1e2", a huge integer) lands in
// Redis as those literal bytes rather than a normalized/quoted form. Used
// only by the numeric-validation tests.
export async function setRawString(r: Redis, key: string, value: string): Promise<void> {
  await r.eval("redis.call('SET', KEYS[1], ARGV[1]) return 'OK'", [key], [value]);
}

// Compare a key's raw stored bytes to an expected string INSIDE Redis, so
// the SDK never deserializes (and thus never normalizes) the value on the
// way back. Returns true iff the stored value is exactly `expected`.
export async function rawEquals(r: Redis, key: string, expected: string): Promise<boolean> {
  const res = await r.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 else return 0 end",
    [key],
    [expected]
  );
  return res === 1;
}
