// Application mode for demonstrations.
//
//   full         booking, payments, tickets, and provider webhooks enabled.
//                Requires Redis, Hyperswitch sandbox keys, APP_ORIGIN, and
//                HYPERSWITCH_WEBHOOK_SECRET. Local development, the test
//                suite, and the checkout harness run in this mode.
//   browse-only  the catalog and event pages only. Every booking, order,
//                status, and webhook route answers 503 before touching
//                Redis or the provider, and the event page does not read
//                inventory (reading it runs hold expiry, which can call the
//                provider and write). Needs no credentials at all.
//
// CONTICX_MODE=full is the ONLY way to enable booking; anything else —
// including unset — is browse-only, so a deployment that forgets the
// setting fails safe rather than taking bookings.

import { jsonNoStore } from "./order-access";

export type AppMode = "full" | "browse-only";

export function appMode(): AppMode {
  return process.env.CONTICX_MODE === "full" ? "full" : "browse-only";
}

export function bookingEnabled(): boolean {
  return appMode() === "full";
}

export function browseOnlyResponse() {
  return jsonNoStore(
    { code: "browse_only", error: "Booking is turned off in this browse-only demo." },
    503
  );
}
