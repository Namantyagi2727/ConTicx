// Application mode for demonstrations.
//
//   full         booking, payments, tickets, and provider webhooks enabled.
//                Requires Redis, Hyperswitch SANDBOX keys, APP_ORIGIN, and
//                HYPERSWITCH_WEBHOOK_SECRET. The public sandbox demo, local
//                development, the test suite, and the checkout harness run
//                in this mode.
//   browse-only  the catalog and event pages only. Every booking, order,
//                status, and webhook route answers 503 before touching
//                Redis or the provider, and the event page does not read
//                inventory (reading it runs hold expiry, which can call the
//                provider and write). Needs no credentials at all.
//
// CONTICX_MODE=full is the ONLY way to enable booking; anything else —
// including unset — is browse-only, so a deployment that forgets the
// setting fails safe rather than taking bookings.
//
// Full mode is sandbox-only. Booking routes also refuse (503
// payments_unavailable) unless the provider configuration is a Hyperswitch
// sandbox — the sandbox API host (or a loopback fake in development and
// tests) with sandbox-prefixed keys — and the Redis key namespace is valid.
// The check reads only the shape of the configuration, never logs it, and
// runs before any Redis or provider work, so a deployment holding live keys
// cannot take a payment.

import { jsonNoStore } from "./order-access";
import { redisKeyPrefixIsValid } from "./redis-keys";

export type AppMode = "full" | "browse-only";

export function appMode(): AppMode {
  return process.env.CONTICX_MODE === "full" ? "full" : "browse-only";
}

export function bookingEnabled(): boolean {
  return appMode() === "full";
}

const SANDBOX_API_ORIGIN = "https://sandbox.hyperswitch.io";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// The provider endpoint and keys can only reach a sandbox.
export function sandboxPaymentsConfigured(): boolean {
  const apiKey = process.env.HYPERSWITCH_API_KEY ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY ?? "";
  if (!apiKey.startsWith("snd_") || !publishableKey.startsWith("pk_snd_")) return false;
  let url: URL;
  try {
    url = new URL(process.env.HYPERSWITCH_BASE_URL ?? "");
  } catch {
    return false;
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return false;
  if (url.origin === SANDBOX_API_ORIGIN) return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

// Full mode with a sandbox-only provider and a valid key namespace.
export function bookingReady(): boolean {
  return bookingEnabled() && sandboxPaymentsConfigured() && redisKeyPrefixIsValid();
}

export function browseOnlyResponse() {
  return jsonNoStore(
    { code: "browse_only", error: "Booking is turned off in this browse-only demo." },
    503
  );
}

export function paymentsUnavailableResponse() {
  return jsonNoStore(
    { code: "payments_unavailable", error: "Booking is temporarily unavailable." },
    503
  );
}

// The gate every booking, order, status, and webhook route runs first: null
// when the request may proceed, otherwise the refusal to return.
export function bookingUnavailable(): Response | null {
  if (!bookingEnabled()) return browseOnlyResponse();
  if (!bookingReady()) return paymentsUnavailableResponse();
  return null;
}
