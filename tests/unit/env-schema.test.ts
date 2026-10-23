import { describe, expect, it } from "vitest";
import { validateEnv } from "../helpers/env-schema";

// T1A-02. Backs the sandbox-only contract from the audit addendum with
// an executable spec. This validator is test-only; runtime enforcement
// is deferred to Phase 1B.

const valid = {
  HYPERSWITCH_BASE_URL: "https://sandbox.hyperswitch.io",
  HYPERSWITCH_API_KEY: "snd_realkeyshape",
  NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY: "pk_snd_realkeyshape",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "sometoken",
};

describe("validateEnv", () => {
  it("accepts a well-formed sandbox configuration", () => {
    expect(validateEnv(valid)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a non-sandbox Hyperswitch host", () => {
    const r = validateEnv({ ...valid, HYPERSWITCH_BASE_URL: "https://api.hyperswitch.io" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("HYPERSWITCH_BASE_URL");
  });

  it("rejects an http (non-https) Hyperswitch base URL", () => {
    const r = validateEnv({ ...valid, HYPERSWITCH_BASE_URL: "http://sandbox.hyperswitch.io" });
    expect(r.ok).toBe(false);
  });

  it("rejects a base URL with an extra path segment", () => {
    const r = validateEnv({ ...valid, HYPERSWITCH_BASE_URL: "https://sandbox.hyperswitch.io/v1" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-sandbox secret key prefix", () => {
    const r = validateEnv({ ...valid, HYPERSWITCH_API_KEY: "pk_live_nope" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("HYPERSWITCH_API_KEY");
  });

  it("rejects a non-sandbox publishable key prefix", () => {
    const r = validateEnv({
      ...valid,
      NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY: "pk_live_nope",
    });
    expect(r.ok).toBe(false);
  });

  it("reports every missing variable", () => {
    const r = validateEnv({});
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects a non-https Upstash URL", () => {
    const r = validateEnv({ ...valid, UPSTASH_REDIS_REST_URL: "redis://example.upstash.io" });
    expect(r.ok).toBe(false);
  });
});
