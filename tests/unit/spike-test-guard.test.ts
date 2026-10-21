import { describe, expect, it } from "vitest";
import { assertLocalSpikeTarget } from "../../scripts/spike-test";

// T1A-11. The spike script must refuse remote targets before any Redis
// or HTTP operation. Tested with fixtures only — no host is contacted.
// Importing the script here does NOT run it: its main() is gated behind
// a direct-run check.

describe("assertLocalSpikeTarget", () => {
  it("allows a local base URL and local Redis", () => {
    expect(() =>
      assertLocalSpikeTarget({
        baseUrl: "http://localhost:3000",
        redisUrl: "http://127.0.0.1:38079",
      })
    ).not.toThrow();
  });

  it("refuses a remote base URL", () => {
    expect(() =>
      assertLocalSpikeTarget({
        baseUrl: "https://conticx.vercel.app",
        redisUrl: "http://127.0.0.1:38079",
      })
    ).toThrow(/base-url/);
  });

  it("refuses a hosted Upstash Redis target", () => {
    expect(() =>
      assertLocalSpikeTarget({
        baseUrl: "http://localhost:3000",
        redisUrl: "https://fancy-cat-1234.upstash.io",
      })
    ).toThrow(/Redis/);
  });

  it("refuses when no Redis URL is set", () => {
    expect(() =>
      assertLocalSpikeTarget({ baseUrl: "http://localhost:3000", redisUrl: undefined })
    ).toThrow(/UPSTASH_REDIS_REST_URL/);
  });
});
