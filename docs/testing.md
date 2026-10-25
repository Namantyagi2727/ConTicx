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
  `lib/hyperswitch.ts` ever see in tests. It also sets
  `APP_ORIGIN=http://localhost`, the trusted origin that route tests send
  as their `Origin` header (plain http, so the guest cookie is not
  `Secure` there; the https cookie is covered by a unit test).
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
  each success has a persisted pending order with a payment id, a guest
  owner, and a hold entry. All 15 come from one guest session. (Assertions read raw Redis values, never clamped UI
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

Used identically by the webhook, the order status refresh (`GET /api/orders/[id]/status`, formerly `GET /api/payments/[id]`), and lazy expiry.
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

## Guest ownership and order access (Phase 1B.4)

Every route that reads or changes an individual order, ticket, payment,
or refund, and what now protects it:

| Route | Protection |
| --- | --- |
| `POST /api/guest-session` | Trusted `Origin` required. Reuses a valid presented session (lifetime renewed); issues a new credential only when none is presented. The credential travels only in `Set-Cookie`. |
| `POST /api/orders` | Trusted `Origin` and an established guest session required, before any inventory read, expiry, or provider call. Owner bound inside the atomic reservation. Never sets a cookie. No provider error body or provider payment id in the response. |
| `GET /api/orders` | Guest session required. Lists only this guest's orders (owner index + per-order ownership re-check), allow-listed fields, `no-store`. |
| `GET /api/orders/[id]` | Guest session, valid UUID, ownership — checked before the order is returned. Side-effect-free read (no expiry, no provider). Same `404` for missing and not-owned. `no-store`. |
| `GET /api/orders/[id]/status` | As above, and only then: for an owned order with an attached payment, the provider read uses the payment id **stored on that order** (validated with `isValidPaymentId` first; a malformed id skips the refresh) and reconciles through the shared policy — as the retired payment-status route did for every lookup. A terminal order keeps its state and inventory; a conflicting outcome is flagged. |
| `POST /api/orders/[id]/refund` | Disabled — fixed `503`, no reads, no provider call, no writes. |
| `GET /api/payments/[id]`, `POST /api/payments/create` | Disabled — fixed `410`, no provider call, no state. |
| `/admin` | Disabled — `notFound()`, reads nothing. |
| `POST /api/webhooks/hyperswitch` | Unchanged: signature-authenticated server-to-server; no guest cookie and no browser-origin check. |

`guest-authorization.regression.test.ts` asserts, against raw Redis state
(a full key-and-value snapshot) and the fake's recorded calls:

- Guest A can read, poll, and list A's order; guest B gets the same `404`
  as a missing order, and B's status poll reaches neither the provider nor
  reconciliation, even with an expired hold queued.
- Missing, malformed, and unknown (well-formed but never issued)
  credentials get `401` from every read route with no provider call, no
  expiry pass, no reconciliation, and no write; a booking without a
  session is refused before any work and never sets a cookie.
- Legacy orders without an owner are unreachable by any guest.
- A different-owner replay, and a replay against a legacy order, are
  conflicts that leave order, inventory, holds, and indexes untouched; a
  wrong-type owner index (string or hash) makes an otherwise valid
  reservation fail before any write — no counter seed, decrement, order,
  hold, or index change, on a new tier or an initialized one; an
  order without a well-formed owner is refused.
- Repeated and concurrent session calls keep one identity across several
  bookings; listings never include another guest's orders or any owner
  hash or provider id.
- Cookie attributes (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`, no
  `Domain`; `Secure` + `__Host-` on https in the unit test), no credential
  in the body or in Redis, and `Cache-Control: no-store`.
- Missing, `null`, malformed, foreign, and Host/forwarded-spoofed origins
  are refused with no session, order, or provider call; an unset
  `APP_ORIGIN` fails closed.
- The disabled refund, payment, and admin routes have no side effects; an
  authenticated webhook still updates a guest's order with no cookie.

`order-status-reconcile.regression.test.ts` ports the Phase 1B.3
payment-status scenarios to the order-scoped status route, including an
owned **terminal** order that receives a conflicting authoritative status:
the provider is read with the order's own payment id, state and inventory
stay put, and the conflict is recorded in `reconcile_needed`. A malformed
stored payment id never reaches a provider path. Mutation checks: dropping
the owner from the replay comparison, accepting any owner, running expiry
before the ownership check, accepting any origin, rotating a valid
session, skipping the session-record lookup, removing the owner-index
type guard, restricting the status refresh to pending orders again, or
dropping the stored payment-id check each fail at least one of these
tests.

### Checkout browser harness

`tests/browser/checkout-harness/run.sh [APP_ORIGIN]` runs the real app
with the two payment-widget packages swapped for local stubs at their
import boundary (`turbopack.resolveAlias` in a harness-only Next config,
copied over `next.config.ts` only inside a temporary `git archive` export
of HEAD — never `.env.local`, never the production config). It uses the
local test Redis and the fake provider, with a loopback control port
(`38172`) to move a fake payment's status. The stubs record what checkout
passes across the boundary on `window.__HYPER_STUB__`, and
`localStorage.hyperStubMode` selects `success` (in-page), `decline`, or
`redirect` (navigates to the return URL with provider-style query
parameters appended).

Checked manually in the browser pane against this harness (Phase 1B.4):

- A fresh browser (no session; `GET /api/orders` → `401`) opened the real
  checkout page from the event page's Get-tickets button. It issued one
  `POST /api/guest-session` and then the booking; the booking succeeded,
  which the server allows only with the cookie that session response set.
- The widget boundary received the publishable-key family (`pk_snd_`) and
  `env: SANDBOX`, the fake payment's exact client secret, a wallet return
  URL of `/confirmation/<local order id>`, and `confirmPayment` with that
  same return URL, `redirect: "if_required"`, and the widgets object.
- In-page success navigated to the confirmation page, which polled
  pending, then showed the ticket after the fake payment moved to
  `succeeded`; the order appeared in My Tickets. The redirect mode landed
  on the same path with `payment_intent_client_secret` and `status`
  appended and resolved the same way. A decline kept the shopper on
  checkout with the error and a retry.
- A failed session bootstrap (browsing an origin other than `APP_ORIGIN`,
  so `POST /api/guest-session` returned `403`) sent no booking request,
  created no order, session, or provider call, and showed "Couldn't
  reserve those tickets" with a link back to the event.
- No browser request left the harness origin; nothing was requested from
  a Hyperswitch domain.

What it does not prove: anything about the real widget or hosted iframe,
Hyperswitch's actual `confirmPayment` results, its real redirect and
wallet return behavior, or cookie behavior on a deployed https origin.
Those remain unverified.

**Strict Mode double booking (found by the harness, fixed).** In `next
dev`, React Strict Mode runs effects setup → cleanup → setup on the same
component. Checkout's booking effect had no cleanup and no reuse, so each
visit sent `POST /api/orders` twice — two holds, two provider payments,
two owned orders, the extra one left pending in My Tickets. Checkout now
keeps the booking promise in a ref keyed by the checkout attempt (event,
tier, quantity): the second setup subscribes to the in-flight booking
instead of posting again, and cleanup only silences that setup's
subscription, so the surviving setup still renders the result. A new
visit (new mount) or different parameters still book. Strict Mode stays
on.

- `checkout-strict-mode.regression.test.tsx` renders the real
  `CheckoutPage` under `<StrictMode>` with react-dom in jsdom (the only
  added dev dependency, pinned), the widget stubs above, and the page's
  same-origin `fetch` routed in-process to the real `/api/guest-session`
  and `/api/orders` handlers with a browser-like cookie jar and Origin
  header. It asserts one session, one booking request, one provider
  payment, one order and one inventory decrement; that the surviving
  component renders the widget with that booking's client secret and
  return URL; that a deliberate second visit books again under the same
  guest; that a booking error is shown from one request; and that
  unmounting mid-flight neither double-books nor logs errors. All four
  failed against the old effect. Mutations that discard the booking in
  cleanup, or skip the second setup without subscribing (a stuck page),
  each fail it.
- Re-run in the harness from a flushed test Redis: one session request
  and one `POST /api/orders` per visit, one provider payment, the GA
  counter down by exactly one; after paying, My Tickets listed only that
  order and no pending hold remained.

This prevents the client from duplicating a booking inside one checkout
attempt. Server-side idempotency (reloads, concurrent requests, lost
responses, payment creation) arrived separately in Phase 1B.5 — see
"Booking attempts and payment creation" below.

**Limitations.**

- **Same browser only.** No cross-device or email recovery; clearing
  browser data, or 90 days without starting a booking or opening My
  Tickets, ends access.
- **First-visit race across tabs.** Two first-ever tabs can be issued
  different credentials before either cookie is stored; the browser keeps
  the last, and an order placed with the other is unreachable from that
  browser. Within one page the session request is shared.
- **No admin or refund access** until the phases that add an admin login
  and authorized, duplicate-safe refunds.
- **Hosted behavior unverified.** The checkout harness proves the page's
  side of the widget contract with a stub; the real widget, real
  Hyperswitch redirect/wallet returns to `/confirmation/<order id>`, and
  cookie behavior behind the production proxy have not been checked
  against the sandbox or a deployment.
- **No rate limiting** on session creation or status polling.
- **Booking idempotency** is per booking attempt since Phase 1B.5 — see
  the next section for what it does and does not cover.

## Booking attempts and payment creation (Phase 1B.5)

### Booking-attempt contract

- **Identity.** A booking attempt is a UUID v4 minted in the browser for
  each deliberate *Get tickets* action (and, once, by checkout for a URL
  that lacks one). It travels in the checkout URL (`&attempt=`), so a
  reload, a retry, or React Strict Mode's effect re-run reuses it, while a
  new *Get tickets* click — even for identical tickets — mints a new one.
  It is not a secret and not a credential: the server scopes it to the
  guest, so presenting it grants nothing to anyone else.
- **Binding.** The reserve script binds
  `booking_attempt:<ownerHash>:<attemptId>` to the new order and its
  canonical request (event, tier, quantity) in the same atomic step as the
  inventory decrement, order, hold, and owner index. Then, for the same
  guest and attempt:
  - same request → the ORIGINAL order is returned (original pricing,
    `createdAt`, hold expiry, and payment identity), no write;
  - changed event, tier, or quantity → `409 attempt_conflict`, no write
    (the UI offers a new booking instead);
  - another guest with the same id → a different key, so an independent
    booking of their own; they never see or claim the original.
- **Closed attempts.** If the bound order is paid, failed, or its hold has
  lapsed, the attempt answers `409 attempt_closed` with the order's status
  and never turns into a new booking (a paid one goes to its ticket).
- **Retention.** Attempt records have no TTL; they live as long as the
  order does, so an unresolved operation can never lapse into a fresh
  booking.

### Provider contract (as established, with sources)

Read on 2026-10-25. Implementation-only rows cite upstream commit
[`4e6a36b`](https://github.com/juspay/hyperswitch/commit/4e6a36b4a62d83491b75686273e8a6c7d0cbe4d2)
(`main` as of 2026-10-24); the hosted sandbox's deployed version is not
known and may differ.

| Claim | Status | Source |
| --- | --- | --- |
| `POST /payments` accepts a merchant-provided `payment_id` (30 characters in the v1 schema) that "ensures idempotency for the payment creation request". | **Documented** | [Payments – Create](https://api-reference.hyperswitch.io/v1/payments/payments--create) |
| No `Idempotency-Key` header is documented for create. | **Documented (absence)** | same |
| `GET /payments/{payment_id}` returns the payment including `client_secret`. | **Documented** | [Payments – Retrieve](https://api-reference.hyperswitch.io/v1/payments/payments--retrieve) |
| Error code `HE_01` is type `duplicate_request`, HTTP 400 or 422; `IR_*` are invalid-request errors (e.g. `IR_01`, 401). | **Documented** | [Error codes](https://api-reference.hyperswitch.io/essentials/error_codes) |
| An error response means no object was created. | **Not documented** — the error-code reference lists codes, statuses, and types only. | same |
| A create whose `payment_id` already exists gets `HE_01` ("The payment with the specified payment_id already exists in our records") and does **not** return the existing payment; request parameters are not compared. | **Implementation only** | [`api_error_response.rs` L80, L437–439](https://github.com/juspay/hyperswitch/blob/4e6a36b4a62d83491b75686273e8a6c7d0cbe4d2/crates/hyperswitch_domain_models/src/errors/api_error_response.rs#L80), [`payment_create.rs`](https://github.com/juspay/hyperswitch/blob/4e6a36b4a62d83491b75686273e8a6c7d0cbe4d2/crates/router/src/core/payments/operations/payment_create.rs) |
| Concurrent creates under one id collapse to one payment: the duplicate maps from the storage layer's `DuplicateValue` (unique constraint) error; other storage errors become 500. | **Implementation only** | [`errors/utils.rs` L77](https://github.com/juspay/hyperswitch/blob/4e6a36b4a62d83491b75686273e8a6c7d0cbe4d2/crates/router/src/core/errors/utils.rs#L77) |
| How long a `payment_id` stays reserved. | **Not established** — assumed permanent (payment intents persist). | — |

Before this phase the wrapper sent no `payment_id` at all (the provider
generated one). `lib/hyperswitch.ts` `createPayment` now sends ours and
classifies the response: `created` (2xx naming our id), `duplicate`
(400/422 + `HE_01`), `refused` (any other 4xx except 408/425/429), and
`uncertain` (transport error, timeout, 5xx, 408/425/429, or an
unrecognised response). **None of these is treated as evidence that no
payment exists.** A refusal describes only the request that received it:
an earlier or concurrent create under the same id may already have made
the payment, or may still be in flight, and neither an HTTP status nor a
GET-not-found rules that out.

The fake provider models exactly the rows above, including the
implementation-only duplicate behaviour. That makes the tests consistent
with the source, **not** a demonstration of hosted-provider parity.

### Payment creation and ambiguous failures

The provider `payment_id` (`pay_` + 26 random `[a-z0-9]`) is chosen and
stored on the order by the reservation itself — before any provider call
— and every creation for that order uses it. `lib/booking.ts`:

1. Paid/failed/lapsed order → closed. Attached payment → re-read it for a
   client secret (no creation).
2. Claim a short lease (`BOOKING_PAYMENT_LEASE_MS`, 15 s); if another
   request holds it, answer `202 processing` with no provider call.
3. Re-read the order under the lease, then **retrieve by our id first**.
   Found → bind (id, order id, amount, currency) and attach (field-scoped)
   → ready.
4. Not found → **create under the same id**. Duplicate → retrieve and
   adopt. Refused → keep the reservation, flag `reconcile_needed`
   (`payment_create_rejected_<status>[_<code>]`), answer
   `502 payment_setup_failed` with `held: true`; the attempt stays open and
   a retry reuses the id. Uncertain → keep the reservation, flag, answer
   `202 processing`.

Payment creation **never releases inventory**. Seats are released only by
the existing authoritative reconciliation paths: a provider status bound
to the order's attached payment (webhook, owner status refresh) or expiry
(which retrieves, cancels at most once, and re-reads). A payment-less held
order stays held and flagged until the recovery phase.

| Failure boundary | Outcome |
| --- | --- |
| Reserved, process stops before the provider call | Retry: retrieve → 404 → create under the stored id → ready. Without a retry, expiry retains and flags it like any payment-less hold. |
| Create sent, response lost / timed out | `202`, reservation kept, flagged; retry retrieves the payment the provider did create and adopts it — no second create. |
| Provider created it, local association failed | `202`; retry retrieves and attaches it. If the lease could not be released (Redis failing), retries answer `processing` until it lapses. |
| Association succeeded, browser response lost | Retry returns the same order; the client secret is re-read from the provider. |
| Concurrent retry during creation | `202 processing`, no provider call (lease). |
| Stale worker resumes after another progressed | Its create is a duplicate or the same payment; its attach is a no-op; a refusal it receives changes nothing (no release), even if the other worker has not yet written the association. |
| Retry refused while an earlier create may still land | Kept and flagged; when the earlier create lands, a request adopts it. No release. |
| Provider refuses (non-duplicate 4xx) | `502 payment_setup_failed`, `held: true`; reservation kept and flagged; a retry of the same attempt reuses the id. |

What reusing the id does and does not establish:

- Reusing the stored `payment_id` relies on the provider's **documented
  creation-idempotency contract** for merchant-provided ids; the concrete
  duplicate response (`HE_01`, no existing payment returned) is
  implementation-observed.
- A **lease lapsing does not establish the outcome** of an earlier request
  — it may still be executing. The lease only avoids redundant calls.
- **Inventory release has separate evidence requirements** (above); no
  creation response satisfies them.
- **Hosted duplicate behaviour and `payment_id` retention remain
  unverified.**

### Tests

`booking-idempotency.regression.test.ts` (22 cases) asserts stored orders,
attempt records, inventory, holds, owner indexes, payment associations,
and the fake's recorded calls for: concurrent identical submissions; replay
after a lost response (same hold, pricing, payment; no new create); changed
inputs; guest isolation; deliberately separate identical bookings; a crash
before creation; provider success then response loss (timeout); 500 after
create; a create that never arrived; provider success then failed
association; a refusal that keeps the reservation and a retry that then
succeeds under the same id; a retry during an in-flight creation; a stale
worker after lease lapse; replay of a paid and of a lapsed attempt;
wrong-type attempt records; malformed attempt/payment identities; and a
missing or invalid attempt id. Three deterministic cases (fake create
gates, a Redis command barrier, deferred promises — no sleeps) cover the
pre-association window: (1) worker A's create is stored at the provider
and its response held, A's lease is removed, worker B finds the payment
and is held just before writing the association, then A receives a
non-duplicate refusal — the order stays pending, seats stay held, and B
then binds the payment with no new reservation or payment; (2) A's create
is in flight but not yet stored, B's retry sees GET-not-found and is
refused — nothing is released, and A's create then lands and is bound;
(3) a stale lease holder's release leaves the current holder's lease
intact. Before the policy fix, (1) and (2) failed (order `failed`, seats
released); restoring the old "release unless a payment is attached"
guard, or releasing on any refusal, fails them again, and an
unconditional lease delete fails (3). Mutations that skip the attempt
replay, drop the attempt-key type guard, skip retrieve-before-create,
release on an uncertain outcome, ignore the lease, mint a new provider id
per attempt, or create for closed orders each fail the suite as well. The Strict Mode suite also checks that a URL without an attempt gets
exactly one minted attempt and no booking before it.

Checkout harness (manual, Phase 1B.5, from a flushed test Redis): reload
resumed the same attempt, order, and payment with the hold clock
continuing; a 500-after-create answered `202` and checkout's automatic
retry adopted the created payment (one create); with retrieves failing,
checkout stopped at "Still setting up your payment" with no create, and
*Try again* (same attempt) then created under the stored id; revisiting a
paid attempt's checkout opened its ticket; reusing an attempt with a
different quantity showed the conflict state and changed nothing.

### What remains

- **Not tested against real services.** Neither the duplicate-`payment_id`
  behaviour nor retrieval semantics has been exercised against the
  Hyperswitch sandbox; the hosted version may differ from upstream `main`.
- **Recovery is deferred.** Uncertain outcomes are flagged in
  `reconcile_needed` and held; nothing yet resolves them in the
  background, flags are not cleared when a later retry succeeds, and
  expiry still retains a payment-less hold without asking the provider
  about its stored `paymentRequestId`.
- **Per attempt, not per purchase intent.** Two separate *Get tickets*
  clicks are two bookings by design. A checkout URL copied into another
  tab shares its attempt (the same order).
- **Orders reserved before this phase** have no stored payment identity;
  the route never creates one for them (it answers `processing` and flags
  them).
- **Client secret lifetime.** The documented client-secret query
  parameter expires after 15 minutes; holds are 10 minutes, so a resumed
  checkout re-reads it from the provider each time.

## Known-defect characterization tests

No characterization tests remain. The last one, `refund-authorization`
(SEC-02, "a refund succeeds for a caller with no ownership proof"), was
**replaced** in Phase 1B.4 by a regression test proving the refund
endpoint is disabled with zero provider or store side effects; refunds
stay disabled until a later phase adds guest authorization and
duplicate-safe provider handling. Earlier conversions: **INV-02**
(Phase 1B.1, `concurrent-refund-release.regression.test.ts`), **SEC-01**
(Phase 1B.2, `webhook-forgery` / `webhook-security`), and **INV-01**
(Phase 1B.3, `expiry-reconciliation`).

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
