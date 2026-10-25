// Trusted application origin (Phase 1B.4). Browser-driven mutations — guest
// session creation and order creation — are accepted only when the request's
// Origin header is EXACTLY this configured origin. The value comes from
// APP_ORIGIN (e.g. "http://localhost:3000" for local development,
// "https://tickets.example.com" in a deployment) and is never derived from
// the incoming Host or X-Forwarded-Host headers, which a client or proxy
// can influence.
//
// Fail closed: if APP_ORIGIN is unset or is not a bare http(s) origin, every
// browser mutation is refused (503) rather than accepted from anywhere. The
// authenticated provider webhook does not go through this check — it is
// server-to-server and carries no browser Origin.
//
// It is also what decides whether the guest cookie is marked Secure (an
// https origin) — see lib/guest-session.ts.

export type OriginCheck =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing" | "malformed" | "foreign" };

// Parses APP_ORIGIN into its canonical origin string, or null when it is
// missing or not a bare http(s) origin (no path, query, fragment, or
// credentials). Read per call so tests and deployments can set it at runtime.
export function trustedOrigin(): string | null {
  const raw = process.env.APP_ORIGIN;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  return url.origin;
}

export function trustedOriginIsSecure(): boolean {
  return trustedOrigin()?.startsWith("https:") ?? false;
}

// Exact comparison against the configured origin. "null" (sandboxed iframes,
// some redirects, file: pages), a missing header, anything that does not
// parse as an origin, and every other origin are rejected.
export function checkRequestOrigin(request: Request): OriginCheck {
  const expected = trustedOrigin();
  if (!expected) return { ok: false, reason: "not_configured" };

  const header = request.headers.get("origin");
  if (header === null || header === "") return { ok: false, reason: "missing" };
  if (header === "null") return { ok: false, reason: "malformed" };

  let presented: string;
  try {
    const url = new URL(header);
    // An Origin header is scheme://host[:port] only.
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      return { ok: false, reason: "malformed" };
    }
    presented = url.origin;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (presented !== header) return { ok: false, reason: "malformed" };

  return presented === expected ? { ok: true } : { ok: false, reason: "foreign" };
}
