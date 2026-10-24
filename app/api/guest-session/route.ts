import { checkRequestOrigin } from "@/lib/app-origin";
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
  const origin = checkRequestOrigin(request);
  if (!origin.ok) return originRejected(origin);

  try {
    const session = await establishGuestSession(request);
    return jsonNoStore({ ok: true }, 200, { "Set-Cookie": session.setCookie });
  } catch (err) {
    console.error(
      "[guest-session] could not establish session:",
      err instanceof Error ? err.message : "unknown"
    );
    return jsonNoStore({ error: "Could not start a session" }, 503);
  }
}
