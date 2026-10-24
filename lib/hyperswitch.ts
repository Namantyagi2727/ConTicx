// Small helper for calling the Hyperswitch REST API from server-side code.
// HYPERSWITCH_API_KEY has no NEXT_PUBLIC_ prefix, so Next.js only ever
// makes it available here — it's never bundled into client-side JS.

const BASE_URL = process.env.HYPERSWITCH_BASE_URL;
const API_KEY = process.env.HYPERSWITCH_API_KEY;

// Bounded request timeout for every provider call. A hung provider
// connection must not hold a request (or a webhook retry) open
// indefinitely. Overridable via HYPERSWITCH_TIMEOUT_MS (read per call, so
// tests can tighten it); the default is generous for normal sandbox
// latency. This is the only behavioral change to the shared helper — a
// timeout benefits every caller and does not alter the happy path.
const DEFAULT_TIMEOUT_MS = 10_000;

function requestTimeoutMs(): number {
  const raw = Number(process.env.HYPERSWITCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export async function hyperswitchFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!BASE_URL || !API_KEY) {
    throw new Error(
      "Missing HYPERSWITCH_BASE_URL or HYPERSWITCH_API_KEY — check .env.local"
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

// The subset of a Hyperswitch payment object this app relies on. Narrowed
// (not the full PaymentsResponse) on purpose: only these fields drive the
// webhook binding and transition decision.
export interface ProviderPayment {
  payment_id: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  merchant_id?: string;
  profile_id?: string;
}

// A deliberately small, stable set of failure categories. The webhook
// handler maps these to retryable-or-not responses without ever surfacing
// the raw provider body (which may carry internal detail we should not
// echo back): a transient failure is retried, a not_found is a permanent
// rejection.
export type RetrievePaymentResult =
  | { ok: true; payment: ProviderPayment }
  | { ok: false; category: "not_found" | "transient" };

// Retrieves the authoritative current state of a payment. Hardened for the
// webhook path:
//   network error / timeout / abort        -> transient (retry)
//   404                                     -> not_found (payment unknown)
//   any other non-2xx                       -> transient (retry)
//   2xx with a non-JSON or malformed body   -> transient (retry)
// The caller is expected to have validated the id's shape first; the
// encodeURIComponent here is a second line of defence for the URL path.
export async function retrievePayment(paymentId: string): Promise<RetrievePaymentResult> {
  let response: Response;
  try {
    response = await hyperswitchFetch(`/payments/${encodeURIComponent(paymentId)}`);
  } catch {
    return { ok: false, category: "transient" };
  }

  if (response.status === 404) return { ok: false, category: "not_found" };
  if (!response.ok) return { ok: false, category: "transient" };

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, category: "transient" };
  }

  const p = data as Record<string, unknown>;
  if (
    typeof p.payment_id !== "string" ||
    typeof p.status !== "string" ||
    typeof p.amount !== "number" ||
    typeof p.currency !== "string"
  ) {
    return { ok: false, category: "transient" };
  }

  return {
    ok: true,
    payment: {
      payment_id: p.payment_id,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      metadata: (p.metadata as Record<string, unknown> | null) ?? null,
      merchant_id: typeof p.merchant_id === "string" ? p.merchant_id : undefined,
      profile_id: typeof p.profile_id === "string" ? p.profile_id : undefined,
    },
  };
}
