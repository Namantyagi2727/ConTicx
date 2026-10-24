// Guest ownership (Phase 1B.4) — no accounts, no login. A browser holds a
// server-issued random credential in an HttpOnly cookie; every order it
// creates is bound to the SHA-256 hash of that credential, and only a
// request presenting the same credential can read the order.
//
//   credential  32 bytes from the CSPRNG (256 bits), base64url, 43 chars.
//               Lives ONLY in the cookie. Never in a URL, a response body,
//               client-readable storage, or a log line.
//   owner hash  sha256(credential), lowercase hex. The only form the server
//               stores: as the session record key and as order.ownerHash.
//               A plain hash (no pepper) is sufficient because the input is
//               a 256-bit random value, not a guessable secret.
//   session     guest_session:<hash>, expiring after
//               GUEST_SESSION_TTL_SECONDS. A credential is valid only while
//               its record exists, so a made-up value owns nothing and the
//               server enforces the lifetime regardless of the cookie.
//   cookie      HttpOnly; SameSite=Lax; Path=/; no Domain; Max-Age = the
//               session lifetime. Secure, with the __Host- name prefix, when
//               the trusted origin is https (lib/app-origin.ts). Plain-http
//               local development cannot use either.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { redis } from "./redis";
import { trustedOriginIsSecure } from "./app-origin";
import { GUEST_SESSION_TTL_SECONDS } from "./constants";
import type { Order } from "./types";

const CREDENTIAL_BYTES = 32;
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;
const OWNER_HASH_RE = /^[0-9a-f]{64}$/;

export function guestCookieName(): string {
  return trustedOriginIsSecure() ? "__Host-conticx_guest" : "conticx_guest";
}

function sessionKey(ownerHash: string) {
  return `guest_session:${ownerHash}`;
}

export function hashGuestCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function isOwnerHash(value: unknown): value is string {
  return typeof value === "string" && OWNER_HASH_RE.test(value);
}

// The first cookie with our name, if it is a well-formed credential. Any
// other shape is treated as absent.
export function readGuestCredential(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const name = guestCookieName();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return CREDENTIAL_RE.test(value) ? value : null;
  }
  return null;
}

export function serializeGuestCookie(credential: string): string {
  const attrs = [
    `${guestCookieName()}=${credential}`,
    `Max-Age=${GUEST_SESSION_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (trustedOriginIsSecure()) attrs.push("Secure");
  return attrs.join("; ");
}

export interface GuestIdentity {
  ownerHash: string;
}

// Resolves the request's guest identity, or null when it presents no valid,
// live session. Performs one Redis read and nothing else — no order reads,
// no expiry, no provider calls.
export async function authenticateGuest(request: Request): Promise<GuestIdentity | null> {
  const credential = readGuestCredential(request);
  if (!credential) return null;
  const ownerHash = hashGuestCredential(credential);
  const live = (await redis.exists(sessionKey(ownerHash))) === 1;
  return live ? { ownerHash } : null;
}

export interface EstablishedSession {
  setCookie: string;
  reused: boolean;
}

// Reuses the presented session when it is valid (renewing its lifetime), so
// repeated or concurrent calls from a browser that already has a session
// never replace its identity. Only a request with no valid session gets a
// NEW credential. The credential appears only in the returned Set-Cookie
// value.
export async function establishGuestSession(request: Request): Promise<EstablishedSession> {
  const presented = readGuestCredential(request);
  if (presented) {
    const renewed = await redis.expire(
      sessionKey(hashGuestCredential(presented)),
      GUEST_SESSION_TTL_SECONDS
    );
    if (renewed === 1) return { setCookie: serializeGuestCookie(presented), reused: true };
  }

  const credential = randomBytes(CREDENTIAL_BYTES).toString("base64url");
  const created = await redis.set(
    sessionKey(hashGuestCredential(credential)),
    JSON.stringify({ createdAt: Date.now() }),
    { nx: true, ex: GUEST_SESSION_TTL_SECONDS }
  );
  // A collision on 256 random bits does not happen in practice; refusing is
  // still the correct response to one.
  if (created !== "OK") throw new Error("guest session could not be created");
  return { setCookie: serializeGuestCookie(credential), reused: false };
}

// True only when the order carries an owner hash equal to the guest's.
// Legacy orders (no ownerHash) are owned by nobody.
export function ownsOrder(order: Pick<Order, "ownerHash">, ownerHash: string): boolean {
  if (!isOwnerHash(order.ownerHash) || !isOwnerHash(ownerHash)) return false;
  return timingSafeEqual(Buffer.from(order.ownerHash, "hex"), Buffer.from(ownerHash, "hex"));
}
