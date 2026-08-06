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
always `tier.priceCents × quantity`, computed from the hardcoded event
catalog in [`lib/events.ts`](lib/events.ts), never trusted from the request
body.

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
2. On checkout, watch the countdown and pay with test card
   `4242 4242 4242 4242`, any future expiry date, any CVC.
3. You should land on the confirmation page with a ticket: event details,
   tier, quantity, order ID, and a QR code encoding the order ID.
4. To see the expired-hold state, let a checkout session's 10-minute
   countdown run out without paying — the payment widget is replaced with
   a "reservation expired" message linking back to the event.

Verify the payment in the Hyperswitch sandbox dashboard to confirm it
actually cleared, not just that the UI looked right.
