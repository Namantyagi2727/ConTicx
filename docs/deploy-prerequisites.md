# Deployment prerequisites

Completed work is published to GitHub on phase branches and reviewed as
pull requests. GitHub Actions CI runs on every push and pull request, and
approved pull requests are merged with a merge commit. **Publishing and
deploying are separate steps:** automatic Vercel Git deployments are
disabled in `vercel.json` (see section 3), and any deployment is its own
explicitly approved action. This note separates three concerns that are
easy to conflate and states what must be verified before anything is
deployed.

## 1. Deployment access protection — *who can reach a deployment*

Vercel's **Standard Protection** (Deployment Protection) puts generated
deployment URLs behind Vercel authentication, so a random visitor cannot
open a preview URL. This controls **access to the URL**. It does **not**
control **what data or credentials that deployment runs with**: a
protected preview can still be wired to the production database and live
payment keys. Access protection is necessary but not sufficient.

## 2. Separation of data and credentials — *what a deployment runs with*

A preview/branch deployment must not read or write production data or use
live payment credentials. Before any branch deployment is allowed to
exist:

- **Redis:** the preview environment must point at a **separate Upstash
  database** (or a scoped test instance), never the production
  `UPSTASH_REDIS_REST_URL` / token. Vercel environment variables are
  scoped per environment (Production / Preview / Development); confirm the
  **Preview** scope does not inherit the production Redis URL and token.
- **Hyperswitch:** the preview environment must use **sandbox** keys
  (`snd_` / `pk_snd_`) and the sandbox base URL, never a live key. A
  preview that can issue real charges or refunds is a production action
  in disguise.

Standard Protection (section 1) provides none of this; it is orthogonal.

### Webhook signing secret (Phase 1B.2)

The Hyperswitch webhook route verifies an HMAC-SHA512 signature over the
raw request body, keyed by the business profile's
`payment_response_hash_key`, supplied to the app as
`HYPERSWITCH_WEBHOOK_SECRET` (server-only; no `NEXT_PUBLIC_` prefix).
Before a deployment can process webhooks:

- Set `HYPERSWITCH_WEBHOOK_SECRET` in the deployment environment to the
  profile's `payment_response_hash_key` (keep production and
  sandbox/preview values separate, like every other credential here). The
  route **fails closed** — with the secret unset it returns `503` and
  mutates nothing — so a deployment without it processes no webhooks
  rather than trusting unsigned ones.
- Configure the Hyperswitch dashboard to deliver webhooks to the
  deployment's `/api/webhooks/hyperswitch` URL, and confirm the profile
  actually has a `payment_response_hash_key` set (a missing key there means
  no signature header is sent).
- Optionally set `HYPERSWITCH_MERCHANT_ID`. When set, the webhook, the
  payment-status read, and hold expiry all require the retrieved payment to
  carry exactly that merchant id (missing or different both fail binding).
  When unset, only the order-association, amount, and currency checks
  apply; no profile id is validated.

The signature check has been exercised only by the test suite, never by a
real Hyperswitch webhook. Real delivery, signing, and `event_id` retry
behavior against the sandbox remain unverified (addendum S1–S10).

### Trusted origin and guest cookie (Phase 1B.4)

- Set `APP_ORIGIN` in every deployment environment to that deployment's
  **exact** public origin (`https://<host>`, no path or trailing slash).
  Guest-session creation and order creation accept only requests whose
  `Origin` header equals it. If it is unset or not a bare origin, both
  fail closed with `503`, so checkout does not work until it is set. It is
  never inferred from `Host` / `X-Forwarded-Host`.
- A preview deployment has its own URL; its `APP_ORIGIN` must be that
  URL, or checkout on it is refused.
- With an https `APP_ORIGIN` the guest cookie is `Secure` and named
  `__Host-conticx_guest` (host-only, `Path=/`). Over plain http (local
  development, `APP_ORIGIN=http://localhost:3000`) it is `conticx_guest`
  without `Secure`. Changing `APP_ORIGIN` between http and https therefore
  changes the cookie name, and browsers' existing sessions stop matching.
- Guest sessions and order ownership live in the same Redis database as
  the orders. Flushing or replacing that database ends every guest's
  access, just as it loses the orders.
- Orders created before Phase 1B.4 have no owner and cannot be opened by
  anyone through the app. There is no migration.
- Refunds, the `/admin` organizer view, and the public payment-id lookup
  are disabled in this phase.

### Booking idempotency relies on unverified provider behaviour (Phase 1B.5)

Order creation sends its own Hyperswitch `payment_id` and, after an
ambiguous result, retries under that same id and resolves a duplicate by
retrieval. The idempotency of a merchant-provided `payment_id` is
documented; the specific duplicate response (400 / `HE_01`, without the
existing payment) comes from the upstream implementation and has not been
exercised against the sandbox. Before relying on it in a deployment,
confirm in the sandbox that a repeated create with the same `payment_id`
returns `HE_01` and that `GET /payments/{payment_id}` returns the
`client_secret`; how long a `payment_id` stays reserved is also
unverified. Payment creation never releases seats — refused or uncertain
creations stay held and flagged until recovery exists — so expect such
holds to accumulate in `reconcile_needed`. See `docs/testing.md`.

## 3. Whether a branch push triggers a deployment

On Vercel's Git integration, pushing a branch normally creates a
**preview deployment** automatically — so `git push` is itself
potentially a deploy trigger. Before a branch is pushed, one of these must
hold — **verified**, not assumed:

- **Branch deployments are disabled** for this branch — e.g. the Vercel
  project's Git settings (`git.deploymentEnabled`) or an Ignored Build
  Step that skips this branch — so the push produces no deployment; **or**
- **The Preview environment is verified-isolated** per section 2 (its own
  Redis database and sandbox-only payment keys), so a preview deployment
  touches no production data or real money.

### Automatic Git deployments are disabled in `vercel.json`

`vercel.json` at the repository root sets
`"git": { "deploymentEnabled": false }`. Vercel's Git configuration docs
say this turns off automatic deployments for **all branches**, `main`
included. Commits, pushes, pull requests, and GitHub Actions CI continue
as normal, and merging a PR is not expected to deploy. Deploying is a
**separate, explicitly approved action**.

The absence of a Vercel status on a commit is consistent with this
setting but does not prove it; only the Vercel dashboard's deployment
list confirms that nothing was deployed.

- The setting lives in the repository, so it covers only commits that
  contain this file. A branch created before it must merge it in first.
- Vercel does not document this setting as covering deployments made with
  the Vercel CLI or through Deploy Hooks. Treat those as still possible,
  and use neither without approval.
- It is separate from the dashboard's Ignored Build Step setting. If the
  project's Root Directory ever moves away from the repository root, this
  file must move with it.

### Demo mode and the hosted build (closeout)

- `CONTICX_MODE=full` is the only setting that enables booking. A
  deployment without it is browse-only: event pages work, every booking,
  order, ticket, and webhook route refuses with `503`, and no Redis,
  Hyperswitch, or origin configuration is needed. This is the intended mode
  for the public portfolio demo.
- The home page reads the mode at request time, so its description always
  matches what the server enforces.
- **Production now serves a browse-only build of `v0.1.0`** at
  <https://conticx.vercel.app>: Vercel deployment
  `dpl_314eyrUMHanKt6rCXFe6SAjmfDNr`, deployed manually on 2026-10-25 with
  Production `CONTICX_MODE=browse-only`.
- **Provenance.** It is a Vercel CLI deployment (source `cli`), so it carries
  **no Git metadata**. It was built from a `git archive` export of tag
  `v0.1.0` (commit `df573e222d1f6a268c96f0c8b609884aa2d5dd9f`) into a new,
  empty directory. Test-only files (`tests/`, `vitest.config.ts`,
  `docker-compose.test.yml`) and every `.env*` file were left out of the
  upload; every remaining file was checked byte-for-byte against the tag.
  The deployment's metadata records `sourceTag`, `sourceCommit`, and
  `exportManifestSha256` (the SHA-256 of the exported files' checksum
  list).
- The previous Production build (`5a04503`, the Phase 1A merge) predates
  every later phase. It no longer serves the public domain, and Standard
  Protection puts its deployment URL behind Vercel login. It was not
  deleted.
- Production still holds the earlier Redis and Hyperswitch variables.
  Browse-only mode never reads them; a booking-enabled deployment would
  additionally need the settings in the checklist below.

## Deployment checklist

Any deployment — re-enabling automatic Git deployments, or deploying
manually — requires **all** of:

1. Explicit authorization from the repository owner for that specific
   deployment.
2. Either (a) verified-disabled branch deployments, **or** (b) a verified
   isolated Preview environment (its own Redis DB + sandbox payment keys).
3. Deployment access protection (Standard Protection) confirmed — this
   gates URL access and is *in addition to*, not a substitute for, (2).
4. For a booking-enabled deployment only: `CONTICX_MODE=full`, `APP_ORIGIN`
   set to the deployment's exact https origin, and
   `HYPERSWITCH_WEBHOOK_SECRET` set (see above). A browse-only deployment
   needs none of these.

This maps to addendum prerequisite **P1** (settle the Vercel
preview-isolation and runtime questions before any branch push) and
**P6** (branch protection on `main` requiring the CI checks, after 1A
merges). The production Node version is likewise a separate deployment
decision — `package.json` intentionally declares no `engines.node` (see
[`testing.md`](testing.md)).

None of this blocks committing, pushing, opening pull requests, or
running CI; it gates only deployment.
