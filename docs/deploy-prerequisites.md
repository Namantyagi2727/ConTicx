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

## Deployment checklist

Any deployment — re-enabling automatic Git deployments, or deploying
manually — requires **all** of:

1. Explicit authorization from the repository owner for that specific
   deployment.
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

None of this blocks committing, pushing, opening pull requests, or
running CI; it gates only deployment.
