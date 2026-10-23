# Testing

This is the Phase 1A test foundation for ConTicx: a local, isolated test
setup that exercises the **current** application and reproduces the
defects from the Phase 0 audit. It changes no application runtime code.

## Prerequisites

- **Node.js 24 LTS**, pinned in [`.nvmrc`](../.nvmrc) and used by local
  runs (`nvm use`) and by CI (`setup-node` reads `.nvmrc`). This is the
  **local and CI** runtime only. `package.json` deliberately declares no
  `engines.node`: that field would override Vercel's project runtime
  selection (a range such as `>=24.0.0` resolves to the latest major
  Vercel offers), and the production Node version is a separate
  deployment decision (addendum prerequisite P1), not something this test
  foundation should force. No production parity is claimed. Vercel's
  handling of `.nvmrc` is undocumented, so `.nvmrc` is not relied on for
  the production runtime either.
- **Docker** (Desktop or a compatible engine) for the local Redis
  services used by the integration tests.
- Dependencies installed: `npm ci` (or `npm install`).

## Commands

```bash
npm run lint           # eslint
npm run typecheck      # next typegen && tsc --noEmit (includes tests)
npm run test:unit      # unit tests only — no Docker needed
npm run test:integration   # integration tests — Docker services required
npm test               # unit + integration
npm run build          # production build (see "Isolated build" below)
```

`typecheck` runs `next typegen` first because the App Router's route types
(`LayoutProps`, `PageProps`, …) are generated into `.next/types`, not
committed. A fresh checkout — such as CI — has no `.next/`, so a bare
`tsc --noEmit` fails there even when it passes in a working copy that has
already run `next dev` or `next build`.

Start the local services before the integration tests:

```bash
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration
docker compose -f docker-compose.test.yml down
```

## Environment isolation

The tests never read `.env.local` and can never reach a real service:

- **Fixed test environment.** `vitest.config.ts` sets `test.env` to
  loopback endpoints and fake, sandbox-shaped credentials before any
  application module is imported, and sets `envDir: false` so Vite loads
  no `.env*` files. These are the only values `lib/redis.ts` and
  `lib/hyperswitch.ts` ever see in tests.
- **Target guard** (`tests/setup/target-guard.ts`). Before the
  integration suite touches anything, it refuses to continue unless the
  Redis and provider URLs are loopback and the Redis token is the
  dedicated test token. A hosted Upstash or Hyperswitch host aborts the
  run. It is unit-tested with fixtures — it never contacts a host.
- **Network guard** (`tests/setup/network-guard.ts`). Wraps the global
  `fetch`. Unit tests block **all** fetches; integration tests allow
  **loopback only**, and force `redirect: "error"` on allowed requests
  so a loopback response cannot bounce the client to a remote host via a
  3xx redirect (the guard only vets the initial URL, and `fetch` follows
  redirects by default). This guards the **`fetch` transport only** — it
  is not an OS-level or all-transport firewall. It covers the app's
  outbound paths because both the Upstash client (`@upstash/redis`) and
  the Hyperswitch helper (`lib/hyperswitch.ts`'s `hyperswitchFetch`) use
  `fetch` and nothing else; a dependency reaching the network through a
  raw socket would bypass it.
- **Spike-test guard.** `scripts/spike-test.ts` now refuses any
  non-loopback base URL or Redis target before doing anything, so it can
  no longer be pointed at the deployed app or a hosted database.

This application-level isolation is separate from dependency downloads
and container-image pulls, which do use the network (npm registry,
Docker registry, and Google Fonts during `next build`). Those are build
inputs, not application traffic, and use no project credentials.

## Local Redis (container lifecycle)

`docker-compose.test.yml` runs two throwaway containers, pinned by
digest, bound to `127.0.0.1` only, with no volumes:

- `redis` — Redis 7.4.11, persistence disabled, on `127.0.0.1:38078`.
- `srh` — `serverless-redis-http`, an Upstash-REST adapter, on
  `127.0.0.1:38079`, so the real `@upstash/redis` client runs unchanged
  against the local database.

```bash
docker compose -f docker-compose.test.yml up -d --wait   # start
docker compose -f docker-compose.test.yml ps             # status
docker compose -f docker-compose.test.yml down           # stop + remove
```

Each integration test flushes the database (`FLUSHDB`) and resets the
fake before it runs, so there is no persistent state to clean up beyond
stopping the containers. The integration setup fails with a clear
message if the adapter is not reachable.

## Isolated build

Two things to be precise about:

1. **`npm run build` in a normal checkout still reads `.env.local`**
   through Next's own env loading. Next does **not** override values
   already present in `process.env`, so exporting placeholder values
   before the build keeps real credentials *out of* the overridden
   variables — but `.env.local` is still loaded for any variable you did
   not override. That is fine for a convenience build, not a clean-room
   one, and the result should be described as such.
2. **The reproducible, fully isolated build** below runs in a throwaway
   workspace that never contains `.env.local` at all (nothing to load),
   and points every service URL at an unreachable `.invalid` host so
   build-time code cannot contact real Redis or the payment provider even
   if a route were executed.

Reproducible procedure — no real `.env` file is read, copied, or
modified:

```bash
# 1. Export only the tracked source/config at the current tree state into
#    a fresh temp dir. git archive excludes .env.local (untracked),
#    node_modules and .next. Swap HEAD for `$(git stash create)` to
#    include uncommitted tracked edits.
TMP=$(mktemp -d)
git archive HEAD | tar -x -C "$TMP"
cd "$TMP"

# 2. Install from the lockfile.
npm ci

# 3. Build with ONLY explicit dummy values on unreachable .invalid hosts,
#    with any inherited app credentials stripped from the environment.
env -u UPSTASH_REDIS_REST_URL -u UPSTASH_REDIS_REST_TOKEN \
    -u KV_REST_API_URL -u KV_REST_API_TOKEN \
    -u HYPERSWITCH_BASE_URL -u HYPERSWITCH_API_KEY \
    -u NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY \
  UPSTASH_REDIS_REST_URL=https://redis.invalid \
  UPSTASH_REDIS_REST_TOKEN=build_placeholder_token \
  HYPERSWITCH_BASE_URL=https://hyperswitch.invalid \
  HYPERSWITCH_API_KEY=snd_build_placeholder \
  NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY=pk_snd_build_placeholder \
  npm run build
```

The build output lists every service-touching route as dynamic (`ƒ`) —
`/admin`, `/api/*`, `/events/[id]` — so none runs during the build; the
statically prerendered pages (`/`, `/_not-found`, `/checkout`,
`/confirmation`, `/my-tickets`) touch neither Redis nor the provider. The
`.invalid` hosts are DNS-unresolvable, so even a stray build-time call
could not reach a real service.

The one external request `next build` makes is to **Google Fonts**
(`next/font/google`): a build input for the UI, not application-service
traffic, carrying no project credentials. A harmless warning — `Failed to
find font override values for font 'Big Shoulders'` — may appear; the
build still succeeds. CI runs this same build with the same
`.invalid`-host placeholders.

## What the tests prove — and what they do not

**Unit** (`tests/unit/`, no network):

- The sandbox-only env schema accepts a valid config and rejects
  non-sandbox hosts, wrong key prefixes, and missing values. (This
  validator is test-only; runtime enforcement is Phase 1B.)
- The target and network guards reject remote targets and block
  disallowed fetches — verified with fixtures, not by contacting hosts.
- The spike-test guard refuses remote targets.

**Integration** (`tests/integration/`, local Redis + fake provider):

- The local adapter supports every command the app uses today, plus the
  Lua paths (EVAL, SCRIPT LOAD + EVALSHA) the Phase 1B transition engine
  will need.
- `POST /api/orders` under 15 concurrent requests for a 10-seat tier
  never oversells: exactly 10 succeed, the raw counter lands at 0, and
  each success has a persisted pending order with a payment id and a
  hold entry. (Assertions read raw Redis values, never clamped UI
  numbers.)
- The network guard refuses to follow a 3xx redirect off a vetted
  loopback URL — verified with a local fixture server that records
  whether the redirect target was requested; no remote host is
  contacted.
- **Atomic store operations (Phase 1B.1).** Reserve-and-create, status
  transitions + inventory release, and payment-id attachment each run as
  a single Redis Lua script. Regression tests assert, on raw Redis
  state: concurrent reservations never exceed capacity and reserves =
  orders = holds = inventory; an insufficient reserve writes nothing;
  two concurrent refunds (and a retried one) release a seat exactly once
  (INV-02 fixed); two conflicting transitions apply exactly one inventory
  effect; a payment-id attach racing a transition never resurrects
  pending state; duplicate attaches no-op and conflicting ones are
  refused.
- **Reservation replay / order-id collision (Phase 1B.1).** Resubmitting
  the same order id — sequentially, concurrently, or as a lost-response
  retry — decrements inventory at most once and returns an `exists`
  result without overwriting the order, resetting its status, or
  recreating a resolved hold; a different booking under the same id is
  rejected (`conflict`) with no mutation. The compared immutable booking
  fields are `eventId`, `tierName`, `currency`, `quantity`,
  `unitPriceCents`, `feeCents`, and `amountCents`, so a differing currency
  or pricing breakdown conflicts even when the total matches. `createdAt`
  and `holdExpiresAt` are deliberately **not** compared — they belong to
  the original attempt and are retained from the stored order, so a
  matching retry preserves the original hold window, progressed status,
  and any payment association. (Internal-operation replay safety, not
  client checkout idempotency, which is deferred.)
- **Initialization vs lost counter (Phase 1B.1).** A persistent per-tier
  `inventory_init:<event>:<tier>` record distinguishes a genuinely new
  tier (seed to full) from a tier whose counter was lost (an absent
  counter alone cannot). With the counter deleted but the init record
  present, the availability read, a new reservation, and a release
  transition all refuse (a clear error / `lost`) rather than reset to
  full or fabricate a counter.
- **Pre-write validation (Phase 1B.1).** A Lua script does **not** roll
  back writes that ran before a later error, so these guarantees rest on
  each script validating — *before* the first mutation — every key it
  writes and every value it computes: order existence, hold-index type,
  the counter's type **and canonical-integer representation** (a value
  `tonumber()` parses but Redis integer ops reject — `"1.5"`, `"1.0"`,
  `"1e2"`, or a leading-zero form like `"01"`; only `"0"` itself is a valid
  zero — is rejected, not silently normalized), positive-integer
  quantities, and capacities/results within an explicit safe bound
  (`MAX_INVENTORY`) so `DECRBY`/`INCRBY` cannot overflow. This validates
  the inputs and stored shapes these scripts touch; it is **not** a claim
  that a Redis script can never fail mid-sequence under any operational
  condition (e.g. an out-of-memory rejection, eviction, or a killed
  instance). Tests feed raw numeric-looking invalid values (written as
  raw bytes so the SDK can't normalize them) and corrupt keys, and assert
  the operation is rejected with no partial write.
- **Webhook authentication, binding, and dedup (Phase 1B.2).** The
  Hyperswitch webhook route verifies an HMAC-SHA512 signature
  (`X-Webhook-Signature-512`, over the exact raw body bytes, keyed by the
  configured `payment_response_hash_key`) **fail-closed, before** any
  parse, Redis, or provider call: a missing / malformed / wrong-length /
  invalid-hex / incorrect signature is `401`, a missing server secret is
  `503`, body tampering or a whitespace change breaks the byte-exact digest
  (`401`), and an invalid delivery performs **zero** Redis and provider
  calls. An authenticated delivery is treated as a *notification*: the
  route retrieves the authoritative payment from the provider and binds it
  two-way — returned id == requested id, the stored order points back at
  this payment, matching amount and currency, and merchant id where
  configured — so metadata alone never authorizes a change. A mismatch is
  `422` with no mutation; an order whose payment id is not yet attached is a
  retryable `503` (a legitimate early webhook), distinct from a permanent
  mismatch. Only the **authoritative provider status** drives a single
  atomic transition (never the event name): `succeeded` marks succeeded,
  `cancelled`/`expired` release inventory, `failed` **retains** it (a failed
  payment may be retried), and any other status gets no terminal outcome
  (retryable). A late success conflicting with an already-terminal order is
  reported, not overwritten. Duplicate deliveries are recognized by
  `event_id` (a bounded-TTL marker written only *after* the durable
  transition): a sequential duplicate skips the provider read, and
  concurrent duplicates still apply the inventory effect exactly once via
  the atomic transition (reprocessing after a lost completion marker does
  not repeat it). Provider timeout / non-JSON / a Redis failure are
  retryable (`503`, no marker). Signature vectors in these tests are
  produced by an **independent** signer, never the route's own verifier.

These prove the **harness** and the **oversell path** behave as
expected. They do **not** prove the application is secure or correct —
see the next section — and they do **not** establish Hyperswitch
contract behavior, which stays deferred to real sandbox checks (addendum
S1–S10).

## Known-defect characterization tests

The files named `*.characterization.test.ts` assert the application's
**current, incorrect** behavior. They pass **because the defect is
present**. They are evidence of a bug, not a guarantee:

| Test | Audit finding | Current behavior it pins |
| --- | --- | --- |
| `expiry-cancel-400.characterization` | INV-01 | A hold whose cancel is rejected with 400 is marked `succeeded` and keeps its seat. |
| `refund-authorization.characterization` | SEC-02 | A refund succeeds for a caller with no ownership proof. |

The **INV-02** double-release characterization was **converted** into a
regression test in Phase 1B.1
(`concurrent-refund-release.regression.test.ts`): it now asserts a single
atomic release. The **SEC-01** unsigned-webhook characterization was
**converted** in Phase 1B.2 (`webhook-forgery.regression.test.ts`, with the
full matrix in `webhook-security.regression.test.ts`): an unsigned or
invalid-signature delivery is now rejected (`401`) with the order left
unchanged. The two rows above remain characterizations — this phase
deliberately did **not** touch the cancel-400 interpretation (INV-01) or
refund authorization (SEC-02), so those defects are still present and these
tests still pass because of it. Do not read a passing characterization test
as a passing security control. Converting the remaining two is the job of
later subphases (real payment status re-fetched after a non-2xx cancel;
unauthorized refund gets a uniform 404). Phase 1B.2 did not change the
cancel-400 reaper path, so it does **not** fix every route that can mark an
order paid — INV-01 remains open.

## Emulator and provider-fake limitations

- **`serverless-redis-http` is not hosted Upstash.** Passing tests here
  do not establish parity with production Upstash (command edge cases,
  error shapes, auto-pipelining behavior, eviction, limits, durability).
  One observed quirk: a numeric-looking sorted-set member can come back
  as a number; real order ids are UUIDs, so this does not affect the
  app, but Phase 1B Lua work should be re-checked against real Upstash.
- **The fake Hyperswitch is minimal and programmed.** It implements only
  the create / retrieve / cancel / refund shapes these tests need, with
  explicit knobs (a 400 cancel, a non-succeeded refund status, a response
  delay for the timeout path, a non-JSON retrieve). It is not a provider
  simulator and proves nothing about the real API's signatures,
  idempotency, status transitions, or timing. The Phase 1B.2 webhook
  verification is written to the **documented** Hyperswitch contract —
  HMAC-SHA512 over the raw body in `X-Webhook-Signature-512`, keyed by
  `payment_response_hash_key` (webhooks integration guide), and the
  terminal-status release policy follows `IntentStatus::is_in_terminal_state`
  (`crates/common_enums/src/enums.rs`) — but the fake does not reproduce
  real signing, event_id semantics, delivery retries, or status timing.
  Confirming those against the sandbox stays deferred (addendum S1–S10).
- **Init-record compatibility (Phase 1B.1).** The lost-counter protection
  relies on the per-tier `inventory_init:<event>:<tier>` record, written
  the first time a tier is seeded after this change. A tier initialized
  *before* this change has a counter but no init record; if that
  counter is later lost, the tier is indistinguishable from a new one and
  would be reseeded to full. By design there is **no** auto-backfill or
  repair of the init record (that would be a migration, out of scope), so
  the guarantee applies only to tiers initialized after this change.
  Losing both the counter and the init record (e.g. a full flush) is also
  indistinguishable from a fresh tier. The init record is an additive new
  key; existing order/inventory/hold storage is unchanged, so no
  migration is required for the rest of the model.
