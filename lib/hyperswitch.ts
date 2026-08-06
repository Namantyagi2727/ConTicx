// Small helper for calling the Hyperswitch REST API from server-side code.
// HYPERSWITCH_API_KEY has no NEXT_PUBLIC_ prefix, so Next.js only ever
// makes it available here — it's never bundled into client-side JS.

const BASE_URL = process.env.HYPERSWITCH_BASE_URL;
const API_KEY = process.env.HYPERSWITCH_API_KEY;

export async function hyperswitchFetch(path: string, init?: RequestInit) {
  if (!BASE_URL || !API_KEY) {
    throw new Error(
      "Missing HYPERSWITCH_BASE_URL or HYPERSWITCH_API_KEY — check .env.local"
    );
  }

  return fetch(`${BASE_URL}${path}`, {
    ...init,
    // Next.js extends fetch with its own caching layer even for
    // external URLs called from route handlers. Payment status is the
    // one thing here that must never be served stale, so every call
    // through this helper (create, cancel, retrieve) opts out.
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "api-key": API_KEY,
      ...init?.headers,
    },
  });
}
