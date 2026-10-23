import { describe, expect, it } from "vitest";
import { assertLocalTargets, RemoteTargetError } from "../setup/target-guard";

// T1A-03 (part). The guard is tested with fixtures only — it never
// contacts any host to prove rejection, it inspects configuration.

const local = {
  UPSTASH_REDIS_REST_URL: "http://127.0.0.1:38079",
  UPSTASH_REDIS_REST_TOKEN: "conticx_test_token",
  HYPERSWITCH_BASE_URL: "http://127.0.0.1:38171",
};

describe("assertLocalTargets", () => {
  it("passes for loopback targets with the test token", () => {
    expect(() => assertLocalTargets(local)).not.toThrow();
  });

  it("rejects a hosted Upstash URL", () => {
    expect(() =>
      assertLocalTargets({ ...local, UPSTASH_REDIS_REST_URL: "https://fancy-cat-1234.upstash.io" })
    ).toThrow(RemoteTargetError);
  });

  it("rejects the real Hyperswitch sandbox host", () => {
    expect(() =>
      assertLocalTargets({ ...local, HYPERSWITCH_BASE_URL: "https://sandbox.hyperswitch.io" })
    ).toThrow(/Hyperswitch/);
  });

  it("rejects a non-loopback Redis host", () => {
    expect(() =>
      assertLocalTargets({ ...local, UPSTASH_REDIS_REST_URL: "http://10.0.0.5:38079" })
    ).toThrow(/loopback/);
  });

  it("rejects a KV_REST_API_URL alias that points remote", () => {
    expect(() =>
      assertLocalTargets({ ...local, KV_REST_API_URL: "https://fancy-cat-1234.upstash.io" })
    ).toThrow(RemoteTargetError);
  });

  it("rejects a non-test Redis token", () => {
    expect(() =>
      assertLocalTargets({ ...local, UPSTASH_REDIS_REST_TOKEN: "prod-looking-token" })
    ).toThrow(/test token/);
  });

  it("rejects a missing Redis URL", () => {
    expect(() =>
      assertLocalTargets({ ...local, UPSTASH_REDIS_REST_URL: undefined })
    ).toThrow(/not set/);
  });
});
