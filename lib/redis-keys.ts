// Optional namespace for every Redis key the app reads or writes.
//
// A deployment that shares its Redis database with other data (an earlier
// prototype's orders and counters, another demo) sets CONTICX_REDIS_PREFIX,
// e.g. "sandbox1", and every key becomes "sandbox1:order:<id>",
// "sandbox1:inventory:<event>:<tier>", and so on — nothing outside the
// namespace is read, written, or counted. Unset, keys are unprefixed, as
// before (local development and the test suite).
//
// The prefix is validated, never interpolated raw: lowercase letters,
// digits, "_" and "-", starting with a letter or digit, at most 32
// characters. An invalid value throws, so a misconfigured deployment fails
// closed instead of writing outside its namespace. Read per call, so tests
// and deployments can change it at runtime.

const PREFIX_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class RedisPrefixError extends Error {
  constructor() {
    super("CONTICX_REDIS_PREFIX must be 1-32 chars of [a-z0-9_-], starting with a letter or digit");
    this.name = "RedisPrefixError";
  }
}

// "" when unset, otherwise "<prefix>:".
export function redisKeyPrefix(): string {
  const raw = process.env.CONTICX_REDIS_PREFIX;
  if (raw === undefined || raw === "") return "";
  if (!PREFIX_RE.test(raw)) throw new RedisPrefixError();
  return `${raw}:`;
}

export function redisKeyPrefixIsValid(): boolean {
  try {
    redisKeyPrefix();
    return true;
  } catch {
    return false;
  }
}

// The namespaced form of an application key.
export function rk(key: string): string {
  return redisKeyPrefix() + key;
}
