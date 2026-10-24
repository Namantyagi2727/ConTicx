// Browser-side helper for the guest session (Phase 1B.4). The credential
// itself is an HttpOnly cookie that this code never sees; establishing the
// session just asks the server to set (or renew) it. Concurrent callers on
// one page share a single request, so a page never races itself into
// issuing two identities.

let inFlight: Promise<boolean> | null = null;

export function ensureGuestSession(): Promise<boolean> {
  if (!inFlight) {
    inFlight = fetch("/api/guest-session", { method: "POST", credentials: "same-origin" })
      .then((res) => res.ok)
      .catch(() => false)
      .then((ok) => {
        // Let a later call retry after a failure; keep a success.
        if (!ok) inFlight = null;
        return ok;
      });
  }
  return inFlight;
}

// One sentence, reused wherever tickets are shown, so the same-browser rule
// is explained consistently.
export const SAME_BROWSER_NOTE =
  "Tickets are saved in this browser only. Clearing your browser data removes access, and they can't be opened on another device yet.";
