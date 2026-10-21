// Fixed, loopback-only endpoints and credentials the test suite uses.
// These are deliberately fake: a dedicated local Redis (through the
// serverless-redis-http adapter) and an in-process fake Hyperswitch.
// No value here points at a real service, and nothing here is read
// from .env.local — see vitest.config.ts (`test.env`) and the target
// guard (tests/setup/target-guard.ts), which together make sure the
// application code under test can never reach a remote host.

// serverless-redis-http adapter, published on 127.0.0.1 by
// docker-compose.test.yml. Port and token must match that file.
export const TEST_REDIS_URL = "http://127.0.0.1:38079";
export const TEST_REDIS_TOKEN = "conticx_test_token";

// Hyperswitch fake: a fixed loopback port, so the URL that
// lib/hyperswitch.ts captures at import time (through vitest's
// `test.env`) is already correct; the integration setup only has to
// make sure the in-process fake is listening on this port before any
// test makes a call. Keys use the sandbox prefixes the app expects but
// are fake values.
export const TEST_HYPERSWITCH_PORT = 38171;
export const TEST_HYPERSWITCH_BASE_URL = `http://127.0.0.1:${TEST_HYPERSWITCH_PORT}`;
export const TEST_HYPERSWITCH_API_KEY = "snd_test_fake_secret_key";
export const TEST_HYPERSWITCH_PUBLISHABLE_KEY = "pk_snd_test_fake_publishable_key";

// Hosts the network guard treats as local. Anything else is blocked.
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
