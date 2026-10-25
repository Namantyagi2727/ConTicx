#!/usr/bin/env bash
# Checkout browser harness (test-only). Runs the REAL app with the two
# payment-widget packages replaced by local stubs, against the local test
# Redis and the in-process fake Hyperswitch — no real credentials and no
# Hyperswitch network traffic.
#
#   tests/browser/checkout-harness/run.sh [APP_ORIGIN]   (default http://127.0.0.1:3000)
#
# Prerequisites: the test Redis is up (docker compose -f docker-compose.test.yml
# up -d --wait), ports 3000 and 38171-38172 are free. It uses that test Redis
# as scratch space, just as the test suite does.
#
# Safety: the app is run from a fresh `git archive` export of HEAD in a
# temporary directory (tracked files only, so never .env.local), with a clean
# environment (`env -i`) carrying only loopback endpoints and fake keys.
set -euo pipefail

APP_ORIGIN_VALUE="${1:-http://127.0.0.1:3000}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="${HARNESS_DIR:-$(mktemp -d)}"
echo "harness export: $WORK"

git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
cp "$WORK/tests/browser/checkout-harness/next.config.harness.ts" "$WORK/next.config.ts"
(cd "$WORK" && npm ci --no-audit --no-fund >/dev/null)

cd "$WORK"
npx tsx tests/browser/checkout-harness/fake-provider.ts &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null || true' EXIT

env -i PATH="$PATH" HOME="$HOME" \
  UPSTASH_REDIS_REST_URL=http://127.0.0.1:38079 \
  UPSTASH_REDIS_REST_TOKEN=conticx_test_token \
  HYPERSWITCH_BASE_URL=http://127.0.0.1:38171 \
  HYPERSWITCH_API_KEY=snd_harness_fake_key \
  NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY=pk_snd_harness_fake_key \
  HYPERSWITCH_WEBHOOK_SECRET=whsec_harness_fake \
  APP_ORIGIN="$APP_ORIGIN_VALUE" \
  NEXT_TELEMETRY_DISABLED=1 \
  npx next dev -p 3000
