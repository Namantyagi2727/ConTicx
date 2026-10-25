// Browser-side helper for the guest session (Phase 1B.4). The credential
// itself is an HttpOnly cookie that this code never sees; establishing the
// session just asks the server to set (or renew) it. Concurrent callers on
// one page share a single request, so a page never races itself into
// issuing two identities.

// "browse_only": the server is running the browse-only demo (no booking).
export type GuestSessionResult = "ok" | "browse_only" | "failed";

let inFlight: Promise<GuestSessionResult> | null = null;

export function ensureGuestSession(): Promise<GuestSessionResult> {
  if (!inFlight) {
    inFlight = fetch("/api/guest-session", { method: "POST", credentials: "same-origin" })
      .then(async (res): Promise<GuestSessionResult> => {
        if (res.ok) return "ok";
        const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
        return body?.code === "browse_only" ? "browse_only" : "failed";
      })
      .catch((): GuestSessionResult => "failed")
      .then((result) => {
        // Let a later call retry after a failure; keep a success.
        if (result !== "ok") inFlight = null;
        return result;
      });
  }
  return inFlight;
}

// Shown wherever the browse-only demo refuses booking or ticket access.
export const BROWSE_ONLY_NOTE =
  "This public demo is browse-only: booking, payments, and tickets are switched off. The full flow runs locally against a simulated payment provider — see the project README.";

// One sentence, reused wherever tickets are shown, so the same-browser rule
// is explained consistently.
export const SAME_BROWSER_NOTE =
  "Tickets are saved in this browser only. Clearing your browser data removes access, and they can't be opened on another device yet.";

// A fresh booking-attempt id (Phase 1B.5). One per deliberate "get tickets"
// action; it travels in the checkout URL so a reload or retry of that
// checkout reuses it. Not a secret and not a credential: the server scopes it
// to this browser's guest session, so it grants nothing to anyone else.
export function newBookingAttemptId(): string {
  return crypto.randomUUID();
}
