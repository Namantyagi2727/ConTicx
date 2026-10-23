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
