// Refuses to let the integration suite run against anything but the
// dedicated local test services. Called once before any integration
// test touches Redis or the provider. It inspects the environment the
// app will actually read (the same variable names lib/redis.ts and
// lib/hyperswitch.ts consume) and throws if any of them look remote, so
// a stray value in the shell or CI can never redirect a destructive
// test at a real database or the Hyperswitch sandbox.

import { LOOPBACK_HOSTS, TEST_REDIS_TOKEN } from "./constants";

export class RemoteTargetError extends Error {
  constructor(message: string) {
    super(`[target-guard] ${message}`);
    this.name = "RemoteTargetError";
  }
}

function assertLoopback(label: string, value: string | undefined): void {
  if (!value) throw new RemoteTargetError(`${label} is not set`);
  let hostname: string;
  try {
    ({ hostname } = new URL(value));
  } catch {
    throw new RemoteTargetError(`${label} is not a valid URL: ${value}`);
  }
  if (/\.upstash\.io$/i.test(hostname)) {
    throw new RemoteTargetError(
      `${label} points at Upstash (${hostname}); refusing to run against a hosted database`
    );
  }
  if (/hyperswitch\.io$/i.test(hostname)) {
    throw new RemoteTargetError(
      `${label} points at Hyperswitch (${hostname}); refusing to call the real provider`
    );
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new RemoteTargetError(`${label} is not a loopback host: ${hostname}`);
  }
}

export interface TargetEnv {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  HYPERSWITCH_BASE_URL?: string;
}

// Exported pure function so it can be unit-tested with fixtures instead
// of by contacting any host (see tests/unit/target-guard.test.ts).
export function assertLocalTargets(env: TargetEnv): void {
  assertLoopback("UPSTASH_REDIS_REST_URL", env.UPSTASH_REDIS_REST_URL);
  // @upstash/redis also reads the KV_* aliases; if they are set they
  // must be local too, or they could silently win.
  if (env.KV_REST_API_URL) assertLoopback("KV_REST_API_URL", env.KV_REST_API_URL);
  assertLoopback("HYPERSWITCH_BASE_URL", env.HYPERSWITCH_BASE_URL);

  if (env.UPSTASH_REDIS_REST_TOKEN !== TEST_REDIS_TOKEN) {
    throw new RemoteTargetError(
      "UPSTASH_REDIS_REST_TOKEN is not the dedicated test token; refusing to proceed"
    );
  }
}

export function assertLocalTargetsFromProcessEnv(): void {
  assertLocalTargets(process.env as TargetEnv);
}
