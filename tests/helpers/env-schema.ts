// A small, test-only validator for the ConTicx environment. Phase 1A
// does NOT wire runtime validation into the app (that is Phase 1B) — this
// lives under tests/ purely to (a) document the contract the audit
// established and (b) back the isolation checks with an executable
// specification. Nothing in app/, components/, or lib/ imports it.
//
// Contract (sandbox-only, per the audit addendum):
//   - HYPERSWITCH_BASE_URL must be exactly https://sandbox.hyperswitch.io
//     (https, that host, no extra path/query) for a real deployment; the
//     test suite itself overrides this with a loopback fake and is NOT
//     validated through this function.
//   - HYPERSWITCH_API_KEY must start with "snd_" (sandbox secret).
//   - NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY must start with "pk_snd_".
//   - Upstash URL/token must be present; the URL must be https.
//
// These prefixes follow the sandbox convention shown in .env.example;
// the addendum lists "exact key prefixes" as a sandbox item still to be
// confirmed against Hyperswitch's own docs (S3), so treat this as the
// documented-intent contract, not a provider guarantee.

export interface EnvInput {
  HYPERSWITCH_BASE_URL?: string;
  HYPERSWITCH_API_KEY?: string;
  NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

export interface EnvResult {
  ok: boolean;
  errors: string[];
}

const SANDBOX_BASE_URL = "https://sandbox.hyperswitch.io";

export function validateEnv(env: EnvInput): EnvResult {
  const errors: string[] = [];

  if (env.HYPERSWITCH_BASE_URL !== SANDBOX_BASE_URL) {
    errors.push(
      `HYPERSWITCH_BASE_URL must be exactly ${SANDBOX_BASE_URL} (got ${
        env.HYPERSWITCH_BASE_URL ?? "undefined"
      })`
    );
  }

  if (!env.HYPERSWITCH_API_KEY) {
    errors.push("HYPERSWITCH_API_KEY is required");
  } else if (!env.HYPERSWITCH_API_KEY.startsWith("snd_")) {
    errors.push("HYPERSWITCH_API_KEY must be a sandbox secret key (prefix snd_)");
  }

  const pk = env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY;
  if (!pk) {
    errors.push("NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY is required");
  } else if (!pk.startsWith("pk_snd_")) {
    errors.push(
      "NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY must be a sandbox publishable key (prefix pk_snd_)"
    );
  }

  if (!env.UPSTASH_REDIS_REST_URL) {
    errors.push("UPSTASH_REDIS_REST_URL is required");
  } else {
    try {
      const { protocol } = new URL(env.UPSTASH_REDIS_REST_URL);
      if (protocol !== "https:") {
        errors.push("UPSTASH_REDIS_REST_URL must use https");
      }
    } catch {
      errors.push("UPSTASH_REDIS_REST_URL must be a valid URL");
    }
  }

  if (!env.UPSTASH_REDIS_REST_TOKEN) {
    errors.push("UPSTASH_REDIS_REST_TOKEN is required");
  }

  return { ok: errors.length === 0, errors };
}
