# ConTicx

A concert ticket booking prototype: browse events, pick a GA or VIP tier, hold
your seat for 10 minutes, pay through [Hyperswitch](https://hyperswitch.io)'s
Unified Checkout, and get a ticket with a QR code. Built as a hackathon-scoped
prototype — real payment flow against Hyperswitch's sandbox, everything else
kept intentionally minimal. Each event's poster art
([`components/PosterArt.tsx`](components/PosterArt.tsx)) is a small
deterministic SVG generator seeded from the event id, standing in for real
photography this prototype doesn't have.

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

`getRemainingInventory` also clamps the counter to `[0, totalInventory]`
on read, not just `>= 0` as before. This isn't a fix for an active bug in
the reserve/release path — that path was already verified live under real
concurrency (see the spike test below) — but building the organizer view
(below) surfaced actual drift on two VIP counters in the long-lived dev
database this project used throughout building it: extensive ad-hoc
testing (interrupted dev-server restarts mid-reap, direct Redis edits for
screenshots) had pushed two counters 1 unit above their seeded total,
which the old floor-only clamp let through as a negative "reserved" count.
The counters were reset once the clamp was added; the clamp itself stays,
as a read-time safety net against whatever future test-database mess
produces the same symptom.

### Webhook-driven status, never the browser alone

The browser redirect after payment only tells you the shopper's screen
changed — not what actually happened at Hyperswitch. Order status
transitions (`"succeeded"` / `"failed"`) are driven by two server-side
sources instead:

1. `POST /api/webhooks/hyperswitch` — authenticates each delivery
   (HMAC-SHA512 over the raw body, `X-Webhook-Signature-512`, keyed by the
   profile's `payment_response_hash_key`; fail-closed), then re-reads the
   payment from Hyperswitch and applies only the transition its
   authoritative status justifies. See `docs/testing.md`.
2. `GET /api/orders/[id]/status` — called by the confirmation page for the
   guest's own order. Ownership is checked first; then the server reads
   the payment id **stored on that order** (shape-checked before it is
   used in a provider path), retrieves it from Hyperswitch, and reconciles
   with the same policy as the webhook — exactly as the old payment-status
   route did, now only for the owner. A pending order may resolve; an
   already-terminal order keeps its state and inventory, and a conflicting
   provider outcome is recorded for reconciliation. A safety net in case
   webhook delivery is delayed or missed.

The confirmation page polls that endpoint (up to 10 times, 2s apart) while
the order is still `"pending"`, then falls back to a "still confirming"
message that points to My Tickets.

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
this was reviewed for the PayPal routing change. Both return URLs point at
`/confirmation/[orderId]` — our own order id, in the path.

Hyperswitch appends its own parameters (such as
`payment_intent_client_secret`) to the return URL for any redirect it
initiates. The confirmation page ignores them: it identifies the order by
the path segment and asks the server for that order's status, so a
provider id is never what grants access to a ticket. (Real wallet and 3DS
redirects have not been re-verified against the sandbox since this
change.)

If a PayPal hold happens to run past its 10-minute window while the
shopper is off on PayPal's site, the existing cancel-first reap logic
above handles it exactly like a slow card confirmation would: no
PayPal-specific case was needed.

### Refunds (disabled)

Online refunds are **turned off** (Phase 1B.4). `POST
/api/orders/[id]/refund` now answers `503` with a fixed message and does
nothing else: no order read, no provider call, no state change. The old
handler refunded any order whose id the caller knew (audit finding
SEC-02), and it had no safe handling of duplicate or asynchronous
provider refunds. The ticket page says online refunds aren't available
yet. A later refund phase will add guest authorization and
duplicate-safe provider handling before refunds come back.
`markOrderRefunded` and the `"refunded"` ticket state remain in place for
that phase.

### No metadata fallback

Every Hyperswitch payment still carries `orderId`, `eventId`, `tierName`,
`quantity`, and `unitPrice` as metadata, and binding checks use it. But a
ticket is never *displayed* from payment metadata any more: if the
browser cannot access the stored order, the page says the order isn't
available rather than reconstructing a ticket from provider data.

### Organizer view (disabled)

`/admin` answers 404 for everyone (Phase 1B.4). It had no authentication
— the unlinked URL was its only protection — while showing sales and
revenue figures and running hold expiry (and therefore provider calls) on
every view. Hiding the link was not protection, so the page itself was
disabled. A protected organizer view needs an admin login, which is out
of scope for now.

### Live demand signal

The event page shows "N people grabbed tickets in the last hour" once
reservation attempts for that event cross a small threshold
(`DEMAND_DISPLAY_THRESHOLD`, `lib/constants.ts`) — revives the "show a
spike in demand" idea from the original project scope that got cut for
time earlier on. `recordDemandSignal` does a plain Redis `INCR` on
`demand:{eventId}` every time an order is created, `EXPIRE`-ing the key
only on the first increment of a window (`DEMAND_WINDOW_SECONDS`, default
1 hour) — an approximate rolling window, not a true sliding one, and
counts reservation *attempts* rather than confirmed sales (the same
"people are actively trying to buy this" signal a real site's urgency
badge is usually making). Good enough for a demand badge; not something
to build billing or analytics on top of.

### Guest ownership and My Tickets

There are no accounts. Instead each browser gets a **guest session**
(Phase 1B.4), and every order belongs to the session that created it:

- **Credential.** `POST /api/guest-session` issues 32 random bytes
  (256 bits) in an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie with no
  `Domain`. On an https `APP_ORIGIN` it is also `Secure`, under the
  `__Host-` name prefix. The server stores only its SHA-256 hash, as a
  session record and as each order's `ownerHash`. The credential never
  appears in a URL, a response body, client-readable storage, or a log.
- **Lifetime.** 90 days, sliding. It restarts each time the browser
  starts a booking or opens My Tickets. A valid session is reused for
  every booking, never rotated per order.
- **Before booking.** Checkout establishes the session *first*, so the
  booking request already carries the cookie that will own the order.
  `POST /api/orders` refuses a request without a valid session (`401`) and
  never sets a cookie itself, so a lost booking response can't also lose
  ownership.
- **Atomic binding.** The owner is written in the same Redis script that
  reserves inventory and stores the order, and the order is indexed under
  its owner in that step. A replay by a different guest, or against a
  legacy order with no owner, is a conflict with no write.
- **Access.**
  - `GET /api/orders/[id]`, `GET /api/orders/[id]/status`, and
    `GET /api/orders` (the list) authenticate the guest before reading
    anything.
  - None of them runs hold expiry.
  - They return one generic `404` for a missing order and for someone
    else's order alike.
  - They expose only allow-listed fields (never `ownerHash` or the
    provider payment id), with `Cache-Control: no-store`.
- **Legacy orders.** Orders created before this phase have no owner, so no
  guest can open them — not by order id, and not by payment id. There is
  no migration or backfill.
- **Same browser only.** `/my-tickets` lists this browser's orders; an
  order id is no longer a lookup credential. Clearing browser data, or
  letting the session lapse, removes access. Cross-device and email
  recovery are not implemented.
- **Known limitation.** Two tabs on a brand-new visit can both ask for a
  session before either has a cookie. The browser keeps whichever cookie
  arrives last, so an order booked with the other one would be unreachable
  from this browser. Each page shares a single session request, and a
  browser that already has a valid session is never re-issued one, so
  this needs two first-ever tabs racing.
- **One booking per booking attempt (Phase 1B.5).** Each *Get tickets*
  click mints a booking-attempt id that checkout keeps in its URL. The
  server binds it, per guest and atomically with the reservation, to one
  order: reloading checkout, retrying after a lost response, or
  submitting concurrently returns that same order (same hold, pricing,
  and payment). Reusing it with different tickets is refused, and a paid,
  failed, or lapsed attempt is never re-booked. The order's provider
  `payment_id` is chosen and stored before any provider call, so every
  creation retry targets the same payment; uncertain provider outcomes
  keep the seats and are flagged for a recovery phase that does not exist
  yet. Details, provider sources, and limits: `docs/testing.md`.

Browser mutations (`POST /api/guest-session`, `POST /api/orders`) are
accepted only when the `Origin` header exactly matches `APP_ORIGIN`. A
missing, `null`, malformed, or foreign origin gets `403`, and an unset
`APP_ORIGIN` fails closed with `503`. The trusted origin is never derived
from `Host` or `X-Forwarded-Host`. There is no CORS. The signed provider
webhook is exempt from this check.

The old public `GET /api/payments/[id]` lookup and the prototype `POST
/api/payments/create` endpoint now answer `410` without contacting
Hyperswitch or touching state.

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
| `HYPERSWITCH_WEBHOOK_SECRET` | The business profile's `payment_response_hash_key`; without it every webhook is refused (`503`) |
| `APP_ORIGIN` | The app's own origin, exactly — `http://localhost:3000` locally, `https://<your-domain>` when deployed. Browser mutations from any other origin are refused, and with it unset they fail closed |

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
3. You should land on `/confirmation/<order id>` with a ticket: event
   details, tier, quantity, order ID, and a QR code encoding the order ID.
4. To see the expired-hold state, let a checkout session's 10-minute
   countdown run out without paying — the payment widget is replaced with
   a "reservation expired" message linking back to the event.
5. Open `/my-tickets` in the same browser — the order should be listed
   and link back to its confirmation page. In a different browser (or a
   private window) the same confirmation link shows "This order isn't
   available".
6. Online refunds and `/admin` are disabled in this phase (see above).

Verify the payment in the Hyperswitch sandbox dashboard to confirm it
actually cleared, not just that the UI looked right.

To exercise the checkout page locally **without** Hyperswitch (payment
widget stubbed, fake provider, local test Redis), use the checkout browser
harness described in `docs/testing.md`.

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
