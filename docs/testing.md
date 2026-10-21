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
npm run typecheck      # tsc --noEmit (includes tests)
npm run test:unit      # unit tests only — no Docker needed
npm run test:integration   # integration tests — Docker services required
npm test               # unit + integration
npm run build          # production build (see "Isolated build" below)
```

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
| `webhook-forgery.characterization` | SEC-01 | An unsigned webhook promotes an order to `succeeded`. |
| `expiry-cancel-400.characterization` | INV-01 | A hold whose cancel is rejected with 400 is marked `succeeded` and keeps its seat. |
| `double-release.characterization` | INV-02 | Two concurrent refunds both release the same seat (forced interleaving). |
| `refund-authorization.characterization` | SEC-02 | A refund succeeds for a caller with no ownership proof. |

**Phase 1B must convert each of these into a regression test that
asserts the corrected behavior** (invalid signature rejected; real
payment status re-fetched after a non-2xx cancel; a single atomic
release; unauthorized refund gets a uniform 404). Until then, do not
read a passing characterization test as a passing security control.

## Emulator and provider-fake limitations

- **`serverless-redis-http` is not hosted Upstash.** Passing tests here
  do not establish parity with production Upstash (command edge cases,
  error shapes, auto-pipelining behavior, eviction, limits, durability).
  One observed quirk: a numeric-looking sorted-set member can come back
  as a number; real order ids are UUIDs, so this does not affect the
  app, but Phase 1B Lua work should be re-checked against real Upstash.
- **The fake Hyperswitch is minimal and programmed.** It implements only
  the create / retrieve / cancel / refund shapes these tests need, with
  explicit knobs (a 400 cancel, a non-succeeded refund status). It is
  not a provider simulator and proves nothing about the real API's
  signatures, idempotency, status transitions, or timing. Those are the
  deferred sandbox checks (addendum S1–S10).
