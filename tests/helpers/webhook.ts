// Independent reference signer for webhook tests. This is deliberately NOT
// the route's verification function (lib/webhook-security.ts) — a test must
// not prove the verifier against itself. It computes the Hyperswitch
// outgoing-webhook signature directly with node:crypto: HMAC-SHA512 over the
// EXACT raw body bytes, hex-encoded. Tests sign a body string once and send
// those same bytes, so the route's recomputation must match.

import { createHmac } from "node:crypto";
import { WEBHOOK_SIGNATURE_HEADER } from "@/lib/webhook-security";

export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
}

// Builds a webhook Request over an EXACT body string. Pass `signature` to
// set the X-Webhook-Signature-512 header; omit (undefined) to send none.
export function makeWebhookRequest(rawBody: string, signature?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers[WEBHOOK_SIGNATURE_HEADER] = signature;
  return new Request("http://localhost/api/webhooks/hyperswitch", {
    method: "POST",
    headers,
    body: rawBody,
  });
}
