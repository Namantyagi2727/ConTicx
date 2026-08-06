# ConTicx

A concert ticket booking prototype: browse events, pick a GA or VIP tier, hold
your seat for 10 minutes, pay through [Hyperswitch](https://hyperswitch.io)'s
Unified Checkout, and get a ticket with a QR code. Built as a hackathon-scoped
prototype — real payment flow against Hyperswitch's sandbox, everything else
kept intentionally minimal.

## Architecture

**Stack:** Next.js (App Router, TypeScript), deployed on Vercel. API routes
are the backend, so the Hyperswitch secret key never reaches the browser —
only `NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY` is client-visible.

### Server-side amount computation

The client never gets to say how much it's paying. `POST /api/orders`
accepts only `eventId`, `tierName`, and `quantity` — the charge amount is
always computed here, from the hardcoded event catalog in
[`lib/events.ts`](lib/events.ts), never trusted from the request body:
subtotal is `tier.priceCents × quantity`, plus a flat `SERVICE_FEE_RATE`
(10%, [`lib/constants.ts`](lib/constants.ts)) service fee on that
subtotal. Both the fee and the subtotal are returned from the order-create
response and shown as their own line items in the checkout order summary
— nothing is folded silently into a bigger number. The Hyperswitch
payment, and any later refund, both use the fee-inclusive total
(`Order.amountCents`), so a refund always returns the full amount actually
charged, fee included.

### Storage: Redis for orders/inventory, hardcoded catalog for events

Orders and tier inventory counters live in [Upstash Redis](https://upstash.com)
([`lib/store.ts`](lib/store.ts)); the event catalog stays a hardcoded module
([`lib/events.ts`](lib/events.ts)). That split is deliberate, not
inconsistent:

- Orders and inventory are read-modify-write state that changes on every
  purchase, and every serverless instance needs to see the same, current
  copy of it. This app started with that state in a single in-memory `Map`,
  which works fine locally but breaks in production: a Hyperswitch webhook
  can land on a completely different Vercel instance than the one that
  created the order, so an in-memory update on instance A is simply
  invisible to instance B. Shared storage is a correctness requirement here,
  not an optimization.
- The event catalog is static and read-only — three hardcoded events, never
  written to at runtime. There's nothing to synchronize across instances, so
  a database round trip would only add latency for no benefit.

Orders are stored as JSON values keyed by order id (`order:{id}`), using the
Upstash SDK's automatic JSON serialization. Inventory is a plain integer per
`(eventId, tierName)` (`inventory:{eventId}:{tierName}`), mutated with
atomic `DECRBY`/`INCRBY` rather than derived by scanning orders — see
"Atomic oversell protection" below.

### Inventory holds + lazy expiry with intent cancellation

Placing an order writes a `"pending"` order with a `holdExpiresAt` 10
minutes out and atomically reserves its inventory (decrements the counter).

There's no background timer expiring holds (this runs on serverless —
nothing guarantees a timer keeps firing between requests). Instead, expiry
is lazy: every store read/write first checks a Redis sorted set of pending
order ids scored by `holdExpiresAt` (`ZRANGEBYSCORE ... -inf <now>` finds
exactly the expired ones, no scan of every order key needed), and for each
expired one, **cancels the Hyperswitch payment intent before** marking the
order expired:

- Cancel succeeds → the intent was still genuinely unpaid → order becomes
  `"expired"`, inventory releases (atomic `INCRBY`).
- Cancel is rejected (Hyperswitch returns 400 because the intent already
  moved past a cancellable state — succeeded, or mid-flight) → the order is
  treated as paid and its inventory is **not** released. A later webhook or
  status check corrects this if it turns out to have actually failed.
- Cancel fails for an unrelated reason (network error, 5xx) → inconclusive,
  left `"pending"` to retry on the next reap pass.

This ordering exists specifically to avoid reselling a seat that was paid
for in the same window its hold happened to expire. See the comment above
`reapExpiredHolds` in `lib/store.ts` for the full reasoning, including a
concurrency bug that was caught and fixed during testing (against the
original in-memory version, still relevant to the Redis one): two tiers'
availability checks running concurrently (`Promise.all`) could both see the
same expired order and race to cancel the same payment twice. Fixed with a
single in-flight promise per instance so concurrent callers on that
instance join one reap pass instead of starting duplicates — Redis's own
atomicity is what keeps two *different* instances reaping at the same
moment from causing the same problem.

### Atomic oversell protection

`reserveInventory` decrements a tier's counter with a single atomic `DECRBY`
— Redis serializes concurrent commands against the same key, so two
simultaneous purchase requests (from the same instance or different ones)
can never both read "1 left" and both succeed. If a decrement takes the
counter below zero, it's immediately rolled back with a compensating
`INCRBY` and that request is told the tier is sold out. The route handler
also does a plain read-and-compare first, but only for a friendlier error
message in the common case — the atomic decrement is what actually
prevents overselling, not the pre-check.

### Webhook-driven status, never the browser alone

The browser redirect after payment only tells you the shopper's screen
changed — not what actually happened at Hyperswitch. Order status
transitions (`"succeeded"` / `"failed"`) are driven by two server-side
sources instead:

1. `POST /api/webhooks/hyperswitch` — receives Hyperswitch's webhook events
   and updates order status from the event payload directly.
2. `GET /api/payments/[id]` — called by the confirmation page, hits
   Hyperswitch directly and reconciles order status as a side effect. This
   is a safety net alongside the webhook in case delivery is delayed or
   missed (there's no signature verification wired up in this sandbox
   prototype — see the comment in the webhook route for what production
   would add: an HMAC-SHA512 check against the `x-webhook-signature-512`
   header using the merchant's `payment_response_hash_key`).

The confirmation page also polls `GET /api/orders/[id]` briefly (up to 5
times, 2s apart) if status is still `"pending"` when it first loads, giving
the webhook a short window to land before falling back to a "still
processing" message.

### Redirect-based payment methods (PayPal)

Card payments confirm in-page — `hyper.confirmPayment({ redirect: "if_required" })`
resolves with a status directly, no navigation. Wallet methods (PayPal,
GPay, Apple Pay) don't: they render as their own button inside the
Unified Checkout widget and handle their own click-to-redirect
internally, which means they **never call our `confirmPayment()` handler
at all** and never see `confirmParams.return_url`. Hyperswitch's docs
call this out as a separate, mandatory option — `options.wallets.walletReturnUrl`
on `<UnifiedCheckout>` itself — and the checkout page was missing it
entirely (`<UnifiedCheckout id="unified-checkout" />`, no options) until
this was reviewed for the PayPal routing change. Both return URLs now
point at `/confirmation`.

The confirmation page's redirect handling itself didn't need to change:
Hyperswitch appends `payment_intent_client_secret` to the return URL for
*any* redirect it initiates — 3DS challenges and wallet flows alike — and
`extractPaymentId` already fell back to parsing that (it was only the
comment above it that wrongly implied this was 3DS-specific). Everything
downstream of extracting a payment id is agnostic to how the shopper got
there: no client-side state from the checkout page carries over (the
browser fully navigates away to PayPal and back), so the confirmation
page re-derives everything from Redis and payment metadata rather than
anything left over in memory — which was already true before this
change, since a hard reload needed to work regardless.

If a PayPal hold happens to run past its 10-minute window while the
shopper is off on PayPal's site, the existing cancel-first reap logic
above handles it exactly like a slow card confirmation would: no
PayPal-specific case was needed.

### Refunds

`POST /api/orders/[id]/refund` — full refunds only, no partial amounts
and no refund-window policy (e.g. "only up to 24h before the event");
those would be checks added in front of this route using data it already
has, not changes to how the refund call itself works. Flow:

1. Reject if the order isn't `"succeeded"` — except `"refunded"` already,
   which returns success immediately without calling Hyperswitch again.
   This is the primary idempotency guard: a duplicate or retried request
   is a safe no-op.
2. Call Hyperswitch `POST /refunds` with `payment_id` and the order's
   full `amountCents` explicitly (never omitted/implicit).
3. Only a `status: "succeeded"` response is treated as done.
   `"pending"`/`"review"` are surfaced as an error instead of tracked
   further — resolving those asynchronously would need a refund webhook
   handler, which is out of scope here.
4. On success, `markOrderRefunded` flips the order and releases its
   inventory with the same atomic `INCRBY` used elsewhere.

Verified live against the real sandbox (not just the happy path): a
genuinely-confirmed test-card payment refunded successfully and released
its seat; the identical request repeated afterward returned the same
success without a second Hyperswitch call or a second inventory release;
and refunding a payment before it had actually succeeded at Hyperswitch
was correctly rejected — Hyperswitch validates refunds against its own
true payment state, which caught a real gap in one of the test setups
along the way (a synthetic webhook had marked an order `"succeeded"` in
Redis without the underlying payment ever actually being confirmed).

The confirmation page shows a "Cancel ticket & refund" button on any
`"succeeded"` ticket; a `"refunded"` order renders the same ticket in a
visibly inactive state (greyed out, QR code desaturated, "no longer valid
for entry") rather than disappearing.

### Metadata fallback

Every Hyperswitch payment is created with `orderId`, `eventId`, `tierName`,
`quantity`, and `unitPrice` attached as metadata. The confirmation page
tries the Redis order store first (authoritative — reflects webhook-driven
updates), and only falls back to reconstructing the ticket display from the
payment's own metadata if the order isn't found there. With shared Redis
storage this fallback should be rare in practice (unlike the old in-memory
version, where it was the normal path whenever a different instance handled
the request) — it's kept as a last resort for something like the Redis
database itself being unreachable. The metadata travels with the payment
regardless, so the ticket still renders correctly either way.

## Local setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local` with your Hyperswitch sandbox keys (Developers > API
keys on the dashboard):

| Variable | Description |
|---|---|
| `HYPERSWITCH_API_KEY` | Secret key — server-side only, never sent to the browser |
| `NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY` | Publishable key — used by the checkout widget |
| `HYPERSWITCH_BASE_URL` | `https://sandbox.hyperswitch.io` |
| `UPSTASH_REDIS_REST_URL` | From an Upstash Redis database's "REST API" tab (console.upstash.com) |
| `UPSTASH_REDIS_REST_TOKEN` | Same tab as above |

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To receive real Hyperswitch webhooks locally, tunnel the app (e.g. `ngrok
http 3000`) and point a webhook URL at
`https://<your-tunnel>/api/webhooks/hyperswitch` from the Hyperswitch
dashboard's business profile settings.

## Testing a payment

1. Go home → pick an event → pick a tier and quantity → **Get tickets**.
2. On checkout, check the order summary breaks out the ticket subtotal,
   a 10% service fee, and the total separately — then pay with test card
   `4242 4242 4242 4242`, any future expiry date, any CVC.
3. You should land on the confirmation page with a ticket: event details,
   tier, quantity, order ID, and a QR code encoding the order ID.
4. To see the expired-hold state, let a checkout session's 10-minute
   countdown run out without paying — the payment widget is replaced with
   a "reservation expired" message linking back to the event.
5. On the confirmation page, click **Cancel ticket & refund** to test the
   refund flow — the ticket should switch to a greyed-out "refunded"
   state.

Verify both the payment and the refund in the Hyperswitch sandbox
dashboard to confirm they actually cleared, not just that the UI looked
right.

## Spike test

`scripts/spike-test.ts` fires a configurable number of concurrent
`POST /api/orders` requests at one event/tier and reports how many
succeeded vs. were rejected as sold out, plus the tier's inventory count
before and after — read straight from Redis, not from the UI, so it's
checking the actual counter rather than a display value. This formalizes
the concurrency test that was originally run by hand (backgrounded curl
requests) while moving inventory to Redis; see "Atomic oversell
protection" above for what it's actually testing.

Run it with the dev server up in another terminal:

```bash
npm run dev            # terminal 1
npm run spike-test -- --event=midnight-parade --tier=VIP --requests=15   # terminal 2
```

All flags are optional (defaults: `midnight-parade`/`VIP`/15 requests/
quantity 1). `--quantity=<n>` and `--base-url=<url>` are also available.

A correct run looks like this — note the tier only had 10 VIP tickets
left, so 15 requests should produce exactly 10 successes:

```
Firing 15 concurrent requests for 1x VIP @ Midnight Parade
Available before: 10 (tier total: 10)

Results:
  succeeded: 10
  rejected (sold out): 5
  inventory: 10 -> 0 (expected 0)

OK — inventory accounting is exact, no oversell.
```

If `reserveInventory`'s atomic `DECRBY` were ever replaced with a
non-atomic read-then-write, this is the test that would catch it: the
final inventory count would land below zero, or `succeeded` would exceed
what was actually available.
