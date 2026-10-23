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
  two-way — returned id == requested id, the payment's metadata names this
  order *and* the stored order points back at this payment id, and matching
  amount and currency — so metadata alone never authorizes a change. When
  `HYPERSWITCH_MERCHANT_ID` is configured the provider response must also
  carry exactly that merchant id: a **missing** merchant id fails binding
  just as a mismatched one does. When it is **not** configured, the merchant
  check is skipped and only the association, amount, and currency checks
  above apply; no profile id (or any other provider field) is validated.
  A mismatch is
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
  the atomic transition. Failures are retryable (`503`, no marker) but
  differ by *when* they happen — see the handler table below: a failure
  **before** the order transition leaves the order unchanged, while a
  failure **after** the transition but before the completion marker can
  return `503` with the order already changed; the redelivery re-runs the
  idempotent transition as a no-op and does not repeat the inventory effect
  (tested). Signature vectors in these tests are produced by an
  **independent** signer, never the route's own verifier.
- **Authoritative reconciliation and bounded hold expiry (Phase 1B.3).**
  The webhook, the payment-status read, and lazy hold expiry now share one
  policy (`lib/payment-policy.ts` binding + status mapping; `lib/store.ts`
  reconciliation and atomic transitions) — see the policy table below. The
  INV-01 rule that a cancellation `400` means "paid" is removed: expiry
  retrieves and binds the payment, applies the status-justified transition,
  and gives a still-cancellable payment one cancellation attempt followed by
  an authoritative re-read; the cancel response itself never produces
  `succeeded` or a release. Tests cover cancel `400` followed by
  `succeeded` (paid, no release) or `failed`/`processing` (retained, never
  paid); confirmed cancellation/expiry releasing once; cancel success then
  an inconclusive re-read (retained + flagged); non-JSON / 5xx / timeout /
  binding mismatch (no guessed outcome); an expired order with no attached
  payment id — legacy or new, with or without an attempt marker — always
  retained and flagged, including a payment id attached (and the marker
  cleared) between expiry's read and its action, and a later verified
  outcome still resolving the retained order; a cancellation timeout or
  transport rejection (retained, flagged `cancel_outcome_unknown`, retried
  later) and a failure to record that flag (hold left in pending work);
  repeated and concurrent passes releasing at most once; webhook success
  racing expiry; a late success against a resolved order (recorded, not
  overwritten); the payment-status read retaining failed payments and
  enforcing binding; the per-pass batch / provider-call bounds with a
  backlog; and the provider-time budget (slow provider stops new work, call
  timeouts capped, passes of one request sharing one budget, a perpetually
  slow hold not starving the others).

These prove the **harness** and the **oversell path** behave as
expected. They do **not** prove the application is secure or correct —
see the next section — and they do **not** establish Hyperswitch
contract behavior, which stays deferred to real sandbox checks (addendum
S1–S10).

## Payment reconciliation policy (Phase 1B.2–1B.3)

### Shared provider-state policy

Used identically by the webhook, `GET /api/payments/[id]`, and lazy expiry.
Only the **authoritative** status from a bound provider retrieval decides an
outcome — never an event name, an HTTP response code, or metadata alone.
Terminal classification follows Hyperswitch's
`IntentStatus::is_in_terminal_state` (`crates/common_enums/src/enums.rs`).

| Authoritative status | Order action | Inventory | Reconciliation flag |
| --- | --- | --- | --- |
| `succeeded` | guarded `pending → succeeded` | kept | — |
| `cancelled` | guarded `pending → failed` | released once | — |
| `expired` | guarded `pending → expired` | released once | — |
| `failed` | none (retained; may be retried, no finality rule implemented) | kept | `payment_failed_retryable` |
| anything else (`processing`, `requires_*`, `review`, `partially_*`, `cancelled_post_capture`, unknown) | none | kept | expiry only, if still non-terminal after its one cancel attempt |
| any of the above, but order already terminal | none (not overwritten) | unchanged | `conflict_<to>_over_<current>` |
| binding mismatch | none | unchanged | expiry: the mismatch reason |

Expiry additions: a still-non-terminal payment gets **one** cancellation
attempt, then a re-read; the cancel response is never used as evidence.

An expired pending order with **no attached payment id** is **never
released** by expiry — for legacy and new orders alike. Neither a missing
payment id nor a missing `payment_attempt:<order>` marker proves that no
provider payment exists (creation can succeed before attachment fails;
legacy orders never had the marker; attach-then-clear can land between
expiry's read and its action). It is retained and flagged
`no_payment_id_unresolved` (or `no_payment_id_attempt_marked` when the marker
is present — the marker is diagnostic only). The flag-and-dequeue is one
Redis script that re-checks the order is still pending with no payment id;
if a payment id was attached after expiry's read, nothing is changed and
the hold stays in pending work for a later pass to reconcile against the
provider (no stale-snapshot action).

**Where unresolved orders go.** Each retained outcome either stays
eligible for lazy retry or moves to the reconciliation set:

| Outcome | Reason | Pending index (`pending_holds`) | Reconciliation index (`reconcile_needed`) |
| --- | --- | --- | --- |
| Provider read transient (first read) | — | kept, re-queued behind earlier holds | — |
| Cancel timeout / transport failure | `cancel_outcome_unknown` | kept, re-queued | yes |
| Cancel issued, re-read transient | `cancel_issued_retrieve_inconclusive` | kept, re-queued | yes |
| Cancel issued, budget gone before re-read | `cancel_issued_retrieve_deferred` | kept, re-queued | yes |
| Budget exhausted before a provider call | — | kept, untouched | — |
| No attached payment id | `no_payment_id_unresolved` / `no_payment_id_attempt_marked` | removed | yes |
| `failed` (retained) | `payment_failed_retryable` | removed | yes |
| Still non-terminal after a cancel | `cancel_then_not_final` | removed | yes |
| Binding mismatch / unknown payment | the mismatch reason | removed | yes |
| Late conflict | `conflict_<to>_over_<current>` | removed | yes |

Outcomes a later lazy read *can* change stay in pending work; outcomes it
cannot (no payment id to read, or a decided-but-unresolved state) move to
the reconciliation set. Re-queueing re-scores the hold to "now" (only if it
is still in the index), so one hold whose reads keep timing out cannot sit
at the head of the queue and consume every pass's budget. A hold only
ever leaves `pending_holds` in the same atomic step that records its flag
and `reconcile_needed` entry; if recording fails, the hold is left exactly
where it was and the error is logged — it is never treated as handled.

**Bounds.** One lazy-expiry pass handles at most `HOLD_EXPIRY_BATCH_SIZE`
(20) expired holds, oldest first, with at most three provider calls each
(retrieve, cancel, re-retrieve). On top of that, request-triggered expiry
has a **provider-time budget**: `HOLD_EXPIRY_PROVIDER_BUDGET_MS` (default
2 s) of wall time spent *inside provider calls*, per instance, per 10 s
window (`HOLD_EXPIRY_BUDGET_WINDOW_MS`). Each call's timeout is capped at the
remaining budget (and at `HYPERSWITCH_TIMEOUT_MS`, default 10 s), and no new
provider call starts once fewer than `HOLD_EXPIRY_MIN_CALL_MS` (250 ms)
remain — the pass stops and every hold it did not reach stays in the index,
untouched, for a later pass. Without the budget the batch cap alone allowed
~20 × 3 × 10 s ≈ 600 s of provider waiting. 2 s was chosen because expiry
runs inline in front of an ordinary request: it bounds the worst-case
housekeeping delay while still letting a normal-latency pass (≈100–500 ms
per call) make progress. The window is shared by every pass that starts in
it, so the several passes one request triggers (order creation runs two to
three) draw on one budget instead of multiplying it; a request that
straddles a window boundary can see at most two windows' budget.

What the budget does **not** bound: Redis round trips and other overhead
(the batch cap bounds those in count, not time), and the provider call
in flight when the budget runs out may finish up to its capped timeout. So
this is a bound on provider waiting, not a hard end-to-end request
deadline. It is per instance: separate instances each have their own
budget. The per-instance single-flight remains an optimisation only —
correctness rests on the atomic `pending → terminal` transition, so
concurrent passes release at most once.

**Reconciliation flags** are a separate durable key per order
(`reconcile:<order>` → `{ reason, at }`) plus a membership entry in the
`reconcile_needed` sorted set (scored by flag time), written together and
without rewriting the order or touching inventory. `ZRANGE reconcile_needed`
enumerates unresolved orders without scanning the keyspace. They are a
backlog for a later recovery phase; nothing in this phase acts on them
automatically, and a flag is **not** cleared when the order later resolves
(e.g. a verified success after a retained hold), so recovery must re-check
the order's current status.

### Webhook handler outcomes

| Condition | HTTP | Order / inventory | Event marker |
| --- | --- | --- | --- |
| Body too large | 413 | unchanged | no |
| Signing secret not configured | 503 | unchanged | no |
| Missing / malformed / wrong signature | 401 | unchanged (zero Redis / provider calls) | no |
| Malformed JSON / bad shape / bad payment-id | 400 | unchanged | no |
| Unsupported (refund / other) event | 200 | unchanged | no |
| Already processed (`event_id` marker present) | 200 | unchanged | already set |
| Provider unknown payment | 422 | unchanged | no |
| Binding mismatch (incl. merchant missing/mismatched when configured) | 422 | unchanged | no |
| Order payment id not yet attached | 503 | unchanged | no |
| Non-terminal provider status | 503 | unchanged | no |
| `failed` | 200 | unchanged (retained, flagged) | yes |
| `succeeded` / `cancelled` / `expired` | 200 | one guarded transition | yes |
| Late status vs already-terminal order | 200 | unchanged (conflict flagged) | yes |
| **Failure before the order transition** (provider timeout / 5xx / non-JSON, Redis failure on read or on the transition itself) | 503 | **unchanged** | no |
| **Failure after the transition, before the marker** (marker write fails) | 503 | **already changed** by the transition | no — redelivery re-runs the transition as a no-op; the inventory effect is not repeated |

## Known-defect characterization tests

The files named `*.characterization.test.ts` assert the application's
**current, incorrect** behavior. They pass **because the defect is
present**. They are evidence of a bug, not a guarantee:

| Test | Audit finding | Current behavior it pins |
| --- | --- | --- |
| `refund-authorization.characterization` | SEC-02 | A refund succeeds for a caller with no ownership proof. |

The **INV-02** double-release characterization was **converted** into a
regression test in Phase 1B.1
(`concurrent-refund-release.regression.test.ts`): it now asserts a single
atomic release. The **SEC-01** unsigned-webhook characterization was
**converted** in Phase 1B.2 (`webhook-forgery.regression.test.ts`, with the
full matrix in `webhook-security.regression.test.ts`): an unsigned or
invalid-signature delivery is now rejected (`401`) with the order left
unchanged. The **INV-01** cancel-400 characterization was **converted** in
Phase 1B.3 (`expiry-reconciliation.regression.test.ts`): a cancellation
response no longer decides the outcome; expiry re-reads the authoritative
status, and a cancel `400` with a still-processing payment is retained and
flagged rather than marked `succeeded`. The one row above remains a
characterization — refund authorization (SEC-02) is untouched, so that
defect is still present and the test still passes because of it. Do not
read a passing characterization test as a passing security control.
Converting it (an unauthorized refund gets a uniform 404) is the job of a
later subphase.

## Emulator and provider-fake limitations

- **`serverless-redis-http` is not hosted Upstash.** Passing tests here
  do not establish parity with production Upstash (command edge cases,
  error shapes, auto-pipelining behavior, eviction, limits, durability).
  One observed quirk: a numeric-looking sorted-set member can come back
  as a number; real order ids are UUIDs, so this does not affect the
  app, but Phase 1B Lua work should be re-checked against real Upstash.
- **The fake Hyperswitch is minimal and programmed.** It implements only
  the create / retrieve / cancel / refund shapes these tests need, with
  explicit knobs (a 400 cancel — optionally revealing a new status, a
  non-succeeded refund status, a response delay for the timeout path, a
  non-JSON or 5xx retrieve, a retrieve that fails only after a cancel, a
  cancel-only delay, a per-payment read delay). It
  is not a provider
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
- **Retained holds are not recovered here (Phase 1B.3).** Conservative
  expiry deliberately keeps a seat allocated whenever the evidence is
  inconclusive: a retryable `failed` payment, a payment still non-terminal
  after one cancel attempt, a cancellation whose outcome is unknown or
  unconfirmed, a binding mismatch, and **every** expired order with no
  attached payment id (legacy or new). Those orders stay `pending` and
  flagged; the ones that cannot gain new evidence from a lazy read leave
  the pending index for `reconcile_needed`, so **their seats remain
  unavailable until a later recovery phase** acts on the flags. In
  particular, a checkout that persisted an order but never attached a
  payment id now holds its seat indefinitely rather than freeing it after
  the hold window. Eventual recovery, orphan-payment discovery (no lookup
  by order id exists), compensation refunds, and scheduled reconciliation
  are **not** implemented. Holds kept for lazy retry are only revisited when
  some request triggers expiry, within the batch and time budget. The
  provider cancel call carries no idempotency key (a retried cancel after
  an unknown outcome may be sent twice). No historical repair or migration
  is performed: legacy records are handled by the same conservative rule.
