// Integration-test setup. Runs in the same worker as the tests, so the
// fake it starts and the env it confirms are the ones the application
// code (imported at the top of each test file) actually uses.
//
// Ordering note: vitest applies `test.env` (which sets the loopback
// Redis and Hyperswitch URLs) before any test module is imported, so by
// the time lib/redis.ts and lib/hyperswitch.ts capture those values at
// import they are already the local ones. This file then (a) refuses to
// continue unless those targets are local, (b) confirms the local Redis
// is reachable, (c) brings up the in-process fake on the fixed port the
// app was told to call, and (d) installs the loopback-only network
// guard. Per test, it flushes Redis and resets the fake.

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { TEST_HYPERSWITCH_PORT } from "./constants";
import { assertLocalTargetsFromProcessEnv } from "./target-guard";
import { installNetworkGuard, restoreNetworkGuard } from "./network-guard";
import { FakeHyperswitch } from "../fakes/hyperswitch";
import { flushTestRedis, pingTestRedis } from "../helpers/redis";

declare global {
  // Shared with tests via getFake() so each test can program and
  // inspect the one fake instance this worker is using.
  var __CONTICX_FAKE__: FakeHyperswitch | undefined;
}

const fake = new FakeHyperswitch();

beforeAll(async () => {
  // (a) Never run destructive integration work against a remote target.
  assertLocalTargetsFromProcessEnv();

  // (b) The local Redis adapter must be up (docker compose). Fail with a
  // clear message rather than a cascade of confusing connection errors.
  if (!(await pingTestRedis())) {
    throw new Error(
      "Local test Redis is not reachable. Start it with:\n" +
        "  docker compose -f docker-compose.test.yml up -d\n" +
        "See docs/testing.md."
    );
  }

  // (c) Bring the fake up on the fixed port the app was configured to call.
  await fake.start(TEST_HYPERSWITCH_PORT);
  globalThis.__CONTICX_FAKE__ = fake;

  // (d) From here on, only loopback fetches are permitted.
  installNetworkGuard("loopback-only");
});

beforeEach(async () => {
  await flushTestRedis();
  fake.reset();
});

afterEach(() => {
  // A test that installed a bespoke race wrapper restores fetch itself;
  // this re-asserts the loopback guard in case one forgot.
  installNetworkGuard("loopback-only");
});

afterAll(async () => {
  restoreNetworkGuard();
  await fake.stop();
  globalThis.__CONTICX_FAKE__ = undefined;
});

export function getFake(): FakeHyperswitch {
  if (!globalThis.__CONTICX_FAKE__) {
    throw new Error("fake hyperswitch not started — integration setup did not run");
  }
  return globalThis.__CONTICX_FAKE__;
}
