# Operating the public sandbox demo

The public demo at <https://conticx.vercel.app> runs in full mode against the
Hyperswitch **sandbox**. This page is the short operator procedure for keeping
it usable. Nothing here involves live payments.

## Settings (Vercel project `con_ticx`, Production)

| Variable | Value |
| --- | --- |
| `CONTICX_MODE` | `full` |
| `APP_ORIGIN` | `https://conticx.vercel.app` |
| `CONTICX_REDIS_PREFIX` | the demo's key namespace, e.g. `sandbox1` |
| `HYPERSWITCH_BASE_URL` | `https://sandbox.hyperswitch.io` |
| `HYPERSWITCH_API_KEY` / `NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY` | sandbox keys (`snd_…` / `pk_snd_…`) |
| `HYPERSWITCH_MERCHANT_ID` | the sandbox merchant id, so every reconciliation checks it |
| `HYPERSWITCH_WEBHOOK_SECRET` | the business profile's `payment_response_hash_key` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | the Redis database |
| `CONTICX_DEMO_BOOKINGS_PER_HOUR` | optional; overall hourly booking cap (default 60, daily cap 5×) |

- Full mode **refuses to run** (booking routes answer `503
  payments_unavailable`) unless the provider settings are a sandbox: the
  `https://sandbox.hyperswitch.io` host with `snd_` / `pk_snd_` keys. Live
  keys therefore can't take a payment.
- The Hyperswitch business profile's webhook URL is
  `https://conticx.vercel.app/api/webhooks/hyperswitch`. Webhooks are
  authenticated with the hash key and are never rate limited.
- On this profile **manual retry is off**, so a declined (`failed`) payment
  can't be confirmed again; the app reads that setting from the provider and
  only then releases the seat. Turning manual retry on makes failed payments
  stay held (and flagged) instead.
- Automatic Git deployments are disabled (`vercel.json`); deployments are
  manual (see [`deploy-prerequisites.md`](deploy-prerequisites.md)).

## The operator report

`scripts/demo-ops.ts` prints, for the demo's namespace only:

- order counts by status;
- pending holds, with time to (or since) expiry;
- orders flagged for reconciliation, with their reason and current status;
- remaining inventory per tier;
- the overall usage counters for the current window.

It is **read-only**, reads nothing outside the namespace, and does not load
`.env.local` — pass the deployment's settings explicitly:

```bash
CONTICX_REDIS_PREFIX=sandbox1 \
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
npx tsx scripts/demo-ops.ts
```

## Unresolved orders

- **Expired holds** need no action. Any later request runs the bounded expiry
  pass: the app cancels the sandbox payment and releases the seats only on an
  authoritative `cancelled`, `expired`, or final `failed` status.
- **Flagged orders** (`reconcile_needed`) are the genuinely uncertain cases —
  for example a payment whose status could not be read, or a failed payment
  whose profile allows retry. They keep their seats on purpose. A later
  webhook or status refresh resolves them. To re-check them now with the
  provider (the same policy, never a timeout-based release), add `--recheck`
  and the sandbox provider settings:

  ```bash
  CONTICX_REDIS_PREFIX=sandbox1 UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
  HYPERSWITCH_BASE_URL=https://sandbox.hyperswitch.io HYPERSWITCH_API_KEY=... \
  NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY=... \
  npx tsx scripts/demo-ops.ts --recheck
  ```

  The flag record stays as history after an order resolves; the report shows
  its current status next to it.
- Never edit counters or delete orders by hand while payments may be in
  flight.

## Fresh demo data

Seats bought in the demo stay sold. To start again with full inventory,
**switch to a new namespace** instead of deleting anything:

1. Run the report and check there are **no pending holds** and no flagged
   orders that are still `pending` (re-check them first if needed).
2. Set `CONTICX_REDIS_PREFIX` to a new value (e.g. `sandbox2`) for
   Production and redeploy the same release.
3. The old namespace is left untouched; earlier guests' tickets in it are no
   longer listed.

## Usage limits

New guest sessions (per client address and overall), new bookings (per
guest, per client address, overall hourly and daily), and status refreshes
(per guest and overall) are bounded; refused requests get `429
rate_limited` with `Retry-After` and charge nothing. Retries of an existing
booking attempt are never limited. Raise the overall cap with
`CONTICX_DEMO_BOOKINGS_PER_HOUR` if the demo is legitimately busy.
