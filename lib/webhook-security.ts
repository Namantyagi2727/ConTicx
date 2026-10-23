// Fail-closed authentication for inbound Hyperswitch webhooks, plus the
// bounded raw-body read they depend on. Pure and server-only (no Redis, no
// provider calls) so it is easy to test in isolation and cannot leak the
// signing secret to the client.
//
// Contract (Hyperswitch outgoing-webhook signing, confirmed against the
// official webhooks integration guide and the pinned source):
//   - Header: `X-Webhook-Signature-512` (HTTP header names are
//     case-insensitive, so the lowercase constant below matches it).
//   - Scheme: HMAC-SHA512 over the EXACT serialized JSON body bytes, keyed
//     by the business profile's `payment_response_hash_key`, hex-encoded.
//     A 64-byte digest -> 128 hex characters.
//   - There is NO timestamp or any other value mixed into the signed
//     message; do not invent one.

import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature-512";

// HMAC-SHA512 -> 64-byte digest -> exactly 128 hex characters.
const SIGNATURE_HEX_LENGTH = 128;
const HEX_RE = /^[0-9a-fA-F]+$/;

export type SignatureFailure = "no_secret" | "missing" | "malformed" | "mismatch";
export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

// Verifies the signature over the raw body bytes. Order matters:
//   - no configured secret  -> we cannot verify at all; a server/config
//     error (503 upstream), distinct from a bad request.
//   - no signature header    -> client auth failure (401).
//   - wrong length / non-hex -> malformed (401); reject BEFORE decoding,
//     because Buffer.from(hex) silently drops a trailing nibble on odd
//     length and stops at the first non-hex char, which would let a
//     malformed signature decode to a shorter buffer.
//   - well-formed but non-matching digest -> mismatch (401).
// The caller performs NO parsing, Redis, or provider work until this
// returns { ok: true }.
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  secret: string | undefined
): SignatureResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!signatureHeader) return { ok: false, reason: "missing" };

  if (signatureHeader.length !== SIGNATURE_HEX_LENGTH || !HEX_RE.test(signatureHeader)) {
    return { ok: false, reason: "malformed" };
  }

  // Hex is case-insensitive; compare the DECODED digest bytes, so the
  // computed digest's casing is irrelevant and the comparison is constant
  // time. Both buffers are a fixed 64 bytes here.
  const provided = Buffer.from(signatureHeader, "hex");
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  if (provided.length !== expected.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

// Hyperswitch payment ids are opaque tokens (e.g. "pay_..."). Validate the
// shape before interpolating into a provider URL path, so a webhook can
// never steer the retrieve call to an arbitrary path (or host) via a
// crafted id.
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function isValidPaymentId(id: unknown): id is string {
  return typeof id === "string" && PAYMENT_ID_RE.test(id);
}

// Reads the request body as raw bytes with an upper bound, so a hostile or
// buggy sender cannot force the handler to buffer an unbounded body. A
// declared Content-Length over the limit is rejected up front; otherwise
// the stream is read and aborted the moment it exceeds the cap. Returns the
// exact bytes, or null when the body is too large (the caller responds
// 413). Reads the body exactly once; the caller reuses the returned buffer
// for both the HMAC and the JSON parse.
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Buffer | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }

  const stream = request.body;
  if (!stream) {
    const buf = Buffer.from(await request.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
