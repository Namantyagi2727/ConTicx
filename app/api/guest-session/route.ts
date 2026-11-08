import { checkRequestOrigin } from "@/lib/app-origin";
import { errorKind, logEvent } from "@/lib/log";
import { bookingUnavailable } from "@/lib/app-mode";
import { establishGuestSession } from "@/lib/guest-session";
import { jsonNoStore, originRejected } from "@/lib/order-access";

// Establishes (or renews) this browser's guest session BEFORE a booking is
// submitted, so the booking request already carries the credential that
// will own the order — losing a booking response can never also lose a
// freshly issued ownership cookie. A browser that already holds a valid
// session keeps it (lifetime renewed); only a browser without one is issued
// a new credential. The credential travels only in the HttpOnly Set-Cookie
// header, never in the body. Same-origin browser requests only.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unavailable = bookingUnavailable();
  if (unavailable) return unavailable;
  const origin = checkRequestOrigin(request);
  if (!origin.ok) return originRejected(origin);

  try {
    const session = await establishGuestSession(request);
    return jsonNoStore({ ok: true }, 200, { "Set-Cookie": session.setCookie });
  } catch (err) {
    logEvent("error", "guest_session.create_failed", { errorKind: errorKind(err) });
    return jsonNoStore({ error: "Could not start a session" }, 503);
  }
}
