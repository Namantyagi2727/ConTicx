import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  TEST_APP_ORIGIN,
  TEST_HYPERSWITCH_API_KEY,
  TEST_HYPERSWITCH_BASE_URL,
  TEST_HYPERSWITCH_PUBLISHABLE_KEY,
  TEST_HYPERSWITCH_WEBHOOK_SECRET,
  TEST_REDIS_TOKEN,
  TEST_REDIS_URL,
} from "./tests/setup/constants";

const root = fileURLToPath(new URL(".", import.meta.url));

// Explicit test environment, set before any application module is
// imported. These are the ONLY values lib/redis.ts and lib/hyperswitch.ts
// will see — all loopback, all fake. .env.local is never consulted
// (envDir:false below, and these are not VITE_-prefixed so Vite would
// not surface them anyway), and the target guard re-checks them before
// the integration suite does anything.
const testEnv = {
  UPSTASH_REDIS_REST_URL: TEST_REDIS_URL,
  UPSTASH_REDIS_REST_TOKEN: TEST_REDIS_TOKEN,
  HYPERSWITCH_BASE_URL: TEST_HYPERSWITCH_BASE_URL,
  HYPERSWITCH_API_KEY: TEST_HYPERSWITCH_API_KEY,
  NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY: TEST_HYPERSWITCH_PUBLISHABLE_KEY,
  HYPERSWITCH_WEBHOOK_SECRET: TEST_HYPERSWITCH_WEBHOOK_SECRET,
  APP_ORIGIN: TEST_APP_ORIGIN,
  // The suite exercises the full booking flow; browse-only mode is tested
  // by switching this per test.
  CONTICX_MODE: "full",
};

export default defineConfig({
  // Don't load .env* files into the test run at all.
  envDir: false,
  // Mirror the app's "@/..." path alias (tsconfig paths) without pulling
  // in an extra plugin.
  resolve: {
    alias: { "@": root },
  },
  test: {
    // Files run one at a time across the whole run. The integration
    // suite binds the fake to a fixed port and shares a single local
    // Redis, so two files running at once would collide; races are
    // forced explicitly in-test, never by parallelism.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 20000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["tests/setup/unit.ts"],
          env: testEnv,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/setup/integration.ts"],
          env: testEnv,
        },
      },
    ],
  },
});
