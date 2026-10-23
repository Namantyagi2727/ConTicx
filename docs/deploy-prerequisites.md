# Deployment prerequisites (before pushing this branch)

Nothing in Phase 1A has been pushed, deployed, or run against a remote
service. Pushing `phase-1a/test-foundation` to GitHub is a **separate,
authorized step**, because on this project a push can trigger a Vercel
deployment. This note separates three concerns that are easy to conflate
and states what must be verified before a first push.

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
- Optionally set `HYPERSWITCH_MERCHANT_ID` to have the route additionally
  verify the retrieved payment's merchant id.

This is **local-only** so far: nothing has been pushed or deployed, and no
real webhook has been received. Real delivery, signing, and `event_id`
retry behavior against the sandbox remain unverified (addendum S1–S10).

## 3. Whether a branch push triggers a deployment

On Vercel's Git integration, pushing a branch normally creates a
**preview deployment** automatically — so `git push` is itself
potentially a deploy trigger. Before the first push, one of these must be
**verified**, not assumed:

- **Branch deployments are disabled** for this branch — e.g. the Vercel
  project's Git settings (`git.deploymentEnabled`) or an Ignored Build
  Step that skips this branch — so the push produces no deployment; **or**
- **The Preview environment is verified-isolated** per section 2 (its own
  Redis database and sandbox-only payment keys), so a preview deployment
  touches no production data or real money.

## First-push checklist

A first push of this branch requires **all** of:

1. Explicit authorization from the repository owner for that specific
   push.
2. Either (a) verified-disabled branch deployments, **or** (b) a verified
   isolated Preview environment (its own Redis DB + sandbox payment keys).
3. Deployment access protection (Standard Protection) confirmed — this
   gates URL access and is *in addition to*, not a substitute for, (2).

This maps to addendum prerequisite **P1** (settle the Vercel
preview-isolation and runtime questions before any branch push) and
**P6** (branch protection on `main` requiring the CI checks, after 1A
merges). The production Node version is likewise a separate deployment
decision — `package.json` intentionally declares no `engines.node` (see
[`testing.md`](testing.md)).

None of this blocks **local** Phase 1B implementation once that phase is
separately approved; it blocks only pushing, deploying, or otherwise
leaving the local machine.
