// Small helper for calling the Hyperswitch REST API from server-side code.
// HYPERSWITCH_API_KEY has no NEXT_PUBLIC_ prefix, so Next.js only ever
// makes it available here — it's never bundled into client-side JS.

import { randomInt } from "node:crypto";

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

// Optional per-call cap. A caller working under its own time budget (lazy
// hold expiry) passes its remaining budget; the effective timeout is the
// smaller of that and the configured helper timeout.
export interface ProviderRequestOptions {
  timeoutMs?: number;
}

export async function hyperswitchFetch(
  path: string,
  init?: RequestInit,
  options?: ProviderRequestOptions
): Promise<Response> {
  if (!BASE_URL || !API_KEY) {
    throw new Error(
      "Missing HYPERSWITCH_BASE_URL or HYPERSWITCH_API_KEY — check .env.local"
    );
  }

  const cap = options?.timeoutMs;
  const timeoutMs =
    cap !== undefined && Number.isFinite(cap) && cap > 0
      ? Math.min(requestTimeoutMs(), cap)
      : requestTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  // Present on create and retrieve responses (documented for retrieve). Only
  // ever forwarded to the order's owner during checkout; never logged.
  client_secret?: string;
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
export async function retrievePayment(
  paymentId: string,
  options?: ProviderRequestOptions
): Promise<RetrievePaymentResult> {
  let response: Response;
  try {
    response = await hyperswitchFetch(
      `/payments/${encodeURIComponent(paymentId)}`,
      undefined,
      options
    );
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
      client_secret: typeof p.client_secret === "string" ? p.client_secret : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Payment creation under a caller-chosen payment_id (Phase 1B.5).
//
// Provider contract this relies on (see docs/testing.md for sources):
//   - documented: the create request accepts a merchant-provided
//     `payment_id` (30 characters in the v1 reference) which "ensures
//     idempotency for the payment creation request";
//   - observed in the upstream implementation, not documented: a create
//     whose payment_id already exists is rejected with HTTP 400, error code
//     HE_01 ("The payment with the specified payment_id already exists in
//     our records") and does NOT return the existing payment, so the caller
//     must retrieve it by id.
// Classification:
//   created    2xx whose body names the requested payment_id and carries a
//              client_secret.
//   duplicate  400 with error code HE_01: a payment with this id exists.
//   rejected   any other 4xx except 408/425/429 — a definitive refusal of
//              the request (treated as: no payment was created).
//   uncertain  network error, timeout, 5xx, 408/425/429, or a 2xx we cannot
//              interpret — the payment may or may not exist.
// ---------------------------------------------------------------------------

export type CreatePaymentResult =
  | { kind: "created"; payment: ProviderPayment & { client_secret: string } }
  | { kind: "duplicate" }
  | { kind: "rejected"; status: number }
  | { kind: "uncertain"; reason: string };

const RETRYABLE_4XX = new Set([408, 425, 429]);

export async function createPayment(request: {
  paymentId: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}): Promise<CreatePaymentResult> {
  let response: Response;
  try {
    response = await hyperswitchFetch("/payments", {
      method: "POST",
      body: JSON.stringify({
        payment_id: request.paymentId,
        amount: request.amount,
        currency: request.currency,
        confirm: false,
        metadata: request.metadata,
      }),
    });
  } catch {
    return { kind: "uncertain", reason: "transport" };
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const body = (data ?? {}) as Record<string, unknown>;

  if (response.ok) {
    if (
      body.payment_id === request.paymentId &&
      typeof body.client_secret === "string" &&
      typeof body.status === "string" &&
      typeof body.amount === "number" &&
      typeof body.currency === "string"
    ) {
      return {
        kind: "created",
        payment: {
          payment_id: body.payment_id,
          status: body.status,
          amount: body.amount,
          currency: body.currency,
          metadata: (body.metadata as Record<string, unknown> | null) ?? null,
          client_secret: body.client_secret,
        },
      };
    }
    return { kind: "uncertain", reason: "unrecognised_success" };
  }

  const errorCode = (body.error as { code?: unknown } | undefined)?.code;
  if (response.status === 400 && errorCode === "HE_01") return { kind: "duplicate" };
  if (response.status >= 400 && response.status < 500 && !RETRYABLE_4XX.has(response.status)) {
    return { kind: "rejected", status: response.status };
  }
  return { kind: "uncertain", reason: `http_${response.status}` };
}

// A fresh provider payment_id in the documented 30-character shape:
// "pay_" + 26 uniformly random characters from [a-z0-9] (26 × log2 36 ≈ 134
// bits), drawn with crypto.randomInt so there is no modulo bias.
export function newPaymentRequestId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "pay_";
  for (let i = 0; i < 26; i++) id += alphabet[randomInt(alphabet.length)];
  return id;
}
