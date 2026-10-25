// Guest-session helpers for route tests (Phase 1B.4). They drive the REAL
// routes: a guest is created through POST /api/guest-session exactly as a
// browser would (trusted Origin header), and the Set-Cookie it returns is
// replayed as a Cookie header on later requests.

import { POST as guestSessionRoute } from "@/app/api/guest-session/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { randomUUID } from "node:crypto";
import type { Order } from "@/lib/types";
import { TEST_APP_ORIGIN } from "../setup/constants";
import { makeTestRedis } from "./redis";

export interface RequestOptions {
  method?: string;
  cookie?: string | null;
  origin?: string | null; // null = no Origin header
  body?: unknown;
}

export function guestRequest(path: string, opts: RequestOptions = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? TEST_APP_ORIGIN;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

// "name=value" from a Set-Cookie header, i.e. what a browser would send back.
export function cookieFromSetCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error("no Set-Cookie header");
  return setCookie.split(";")[0];
}

// Establishes a guest session (optionally presenting an existing cookie)
// and returns the cookie the browser would now hold.
export async function newGuest(existingCookie?: string): Promise<string> {
  const res = await guestSessionRoute(
    guestRequest("/api/guest-session", { method: "POST", cookie: existingCookie })
  );
  if (res.status !== 200) throw new Error(`guest session setup failed: ${res.status}`);
  return cookieFromSetCookie(res.headers.get("set-cookie"));
}

// A booking request. Each call gets a fresh booking attempt unless `body`
// supplies one, so separate calls are independent bookings (Phase 1B.5).
export function orderRequest(
  cookie: string | null,
  body: Record<string, unknown> = { eventId: "midnight-parade", tierName: "VIP", quantity: 1 },
  origin?: string | null
): Request {
  const withAttempt = "attemptId" in body ? body : { ...body, attemptId: randomUUID() };
  return guestRequest("/api/orders", { method: "POST", cookie, body: withAttempt, origin });
}

// Creates an order through the real route as `cookie`'s guest (a fresh
// guest when omitted). The provider payment id is no longer in the route's
// response, so it is read from the stored order.
export async function createOwnedOrder(
  cookie?: string,
  quantity = 1
): Promise<{ orderId: string; paymentId: string; cookie: string }> {
  const guest = cookie ?? (await newGuest());
  const res = await createOrderRoute(
    orderRequest(guest, { eventId: "midnight-parade", tierName: "VIP", quantity })
  );
  if (res.status !== 200) throw new Error(`order setup failed: ${res.status}`);
  const { orderId } = await res.json();
  const stored = await makeTestRedis().get<Order>(`order:${orderId}`);
  if (!stored?.paymentId) throw new Error("order setup failed: no payment attached");
  return { orderId, paymentId: stored.paymentId, cookie: guest };
}
