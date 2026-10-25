# Walkthrough recording script

A 2–3 minute screen recording of ConTicx. No recording was captured as part
of the closeout (the available browser tooling has no video capture), so this
is a script and set of reproducible steps to record one.

**Label simulated payments on screen.** Everything in Part 2 uses the local
checkout harness: a fake Hyperswitch and a stub payment widget. Say so at
the start of Part 2 and keep the `TEST PAYMENT WIDGET (STUB)` box visible.

## Setup (before recording)

```bash
npm ci
docker compose -f docker-compose.test.yml up -d --wait
tests/browser/checkout-harness/run.sh            # full mode, http://127.0.0.1:3000
```

For Part 1, in a second terminal, run a browse-only production build with no
environment variables:

```bash
mkdir -p /tmp/conticx-browse && git archive HEAD | tar -x -C /tmp/conticx-browse && cd /tmp/conticx-browse
npm ci && env -i PATH="$PATH" HOME="$HOME" npx next build
env -i PATH="$PATH" HOME="$HOME" npx next start -p 3001   # http://localhost:3001
```

Use a fresh browser profile (or a private window) so no earlier guest
session exists.

## Part 1 — the public, browse-only demo (≈30 s)

1. Open <http://localhost:3001>. Point out the *Portfolio demo* label and the
   browse-only note.
2. Open an event. Tiers show capacity, not live availability, and the buy
   controls are replaced by the browse-only explanation.
3. Narrate: in this mode the booking, order, ticket, and webhook routes
   refuse on the server, before touching Redis or the payment provider, and
   the deployment needs no credentials.

## Part 2 — the full flow, simulated payments (≈90 s)

> "This part runs locally against a simulated payment provider. Nothing
> here talks to real Hyperswitch."

1. Open <http://127.0.0.1:3000>, choose **Midnight Parade**, select **VIP**,
   quantity **2**, press **Get tickets**.
2. Checkout: point out the server-computed total ($200 + $20 fee), the
   ten-minute countdown, and the stub widget.
3. **Reload the page.** Same order, and the countdown continues instead of
   resetting — the booking attempt in the URL is idempotent on the server.
4. Press **Pay**. The confirmation page shows *Still confirming your
   payment*.
5. In a terminal, mark the simulated payment as succeeded:

   ```bash
   curl -s http://127.0.0.1:38172/payments
   curl -s -X POST "http://127.0.0.1:38172/set-status?payment_id=<id>&status=succeeded"
   ```

6. The ticket appears: doors and show times, the QR code, *Valid for entry*.
   Press **Add to calendar** and open the `.ics`.
7. Open **My tickets** — the order is listed for this browser only.

## Part 3 — what is underneath (≈30 s, optional)

- Show a structured log line from the harness terminal (`"event":"request"`,
  `op`, `outcome`, `durationMs`, `requestId`) and the matching
  `X-Request-Id` response header.
- Open the same confirmation URL in a private window: *This order isn't
  available* — order ids are not access credentials.
- Mention the test suite (`npm test`, 239 tests) and that real Hyperswitch
  behaviour is documented but unverified.
