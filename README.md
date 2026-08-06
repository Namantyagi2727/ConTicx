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

### Inventory holds + lazy expiry with intent cancellation

Orders and inventory live in a single in-memory `Map`
([`lib/store.ts`](lib/store.ts)) — deliberate prototype scope, not a
database. It survives Next.js dev hot-reloads and warm serverless
invocations (attached to `globalThis`), but resets on a cold start or
redeploy. Fine for a live demo, not for production.

Placing an order writes a `"pending"` order with a `holdExpiresAt` 10
minutes out. Remaining inventory for a tier is computed on every read by
summing the quantities of all `"pending"` + `"succeeded"` orders for that
tier and subtracting from its total — not a separately maintained counter
that could drift.

There's no background timer expiring holds (this runs on serverless —
nothing guarantees a timer keeps firing between requests). Instead, expiry
is lazy: every store read/write first checks for `"pending"` orders whose
hold has passed, and for each one, **cancels the Hyperswitch payment intent
before** marking the order expired:

- Cancel succeeds → the intent was still genuinely unpaid → order becomes
  `"expired"`, inventory releases.
- Cancel is rejected (Hyperswitch returns 400 because the intent already
  moved past a cancellable state — succeeded, or mid-flight) → the order is
  treated as paid and its inventory is **not** released. A later webhook or
  status check corrects this if it turns out to have actually failed.
- Cancel fails for an unrelated reason (network error, 5xx) → inconclusive,
  left `"pending"` to retry on the next reap pass.

This ordering exists specifically to avoid reselling a seat that was paid
for in the same window its hold happened to expire. See the comment above
`reapExpiredHolds` in `lib/store.ts` for the full reasoning, including a
concurrency bug that was caught and fixed during testing: two tiers'
availability checks running concurrently (`Promise.all`) could both see the
same expired order and race to cancel the same payment twice. Fixed with a
single in-flight promise so concurrent callers join one reap pass instead
of starting duplicates.

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
tries the in-memory order store first (authoritative — reflects
webhook-driven updates), and only falls back to reconstructing the ticket
display from the payment's own metadata if the order isn't found there —
which happens if a different serverless instance created it and this one's
memory never had it. The metadata travels with the payment regardless of
which instance handles the request, so the ticket still renders correctly
either way.

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
