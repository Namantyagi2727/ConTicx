// Structured logging and request correlation for the server routes.
//
// This is not tracing: each log line is one JSON object written through the
// runtime's own console (stdout/stderr, which the hosting platform already
// collects). The booking, order-status, and webhook routes run inside
// runLogged, which gives every request a server-generated requestId, returns
// it as the X-Request-Id response header, and writes one summary line with
// the operation, outcome, HTTP status, and duration.
//
// Safety rules, enforced here rather than at each call site:
//   - Only allow-listed field names are written; anything else is dropped.
//     There is deliberately no field for cookies, guest credentials, owner
//     hashes, client secrets, authorization headers, request/webhook bodies,
//     provider payloads, or booking-attempt ids.
//   - Errors are logged by class name only (errorKind). Error messages can
//     embed Redis command arguments — e.g. an order JSON with its owner hash
//     — so they are never written.
//   - Strings are truncated; only primitives are written.
//   - Logging never throws into the request: every failure is swallowed, so
//     it cannot change payment or inventory behaviour.

import { randomBytes } from "node:crypto";

export type LogLevel = "info" | "warn" | "error";
type FieldValue = string | number | boolean | null;

const ALLOWED_FIELDS = new Set([
  "requestId",
  "upstreamRequestId",
  "op",
  "outcome",
  "status",
  "durationMs",
  "orderId",
  "eventId",
  "webhookEventId",
  "reason",
  "errorKind",
  "replayed",
]);

const MAX_STRING = 200;

export type LogFields = Record<string, unknown>;

function sanitize(fields: LogFields): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_STRING);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitize(fields) });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // Logging must never affect the request.
  }
}

// The class of an error, never its message.
export function errorKind(err: unknown): string {
  return err instanceof Error ? err.name || "Error" : "unknown";
}

// Server-generated request id: "req_" + 16 base64url characters (96 bits).
export function newRequestId(): string {
  return `req_${randomBytes(12).toString("base64url")}`;
}

// An inbound correlation id from a proxy or platform (x-request-id, or
// Vercel's x-vercel-id) is recorded only as upstreamRequestId, and only if it
// is short and made of safe characters. It never replaces our own id.
const UPSTREAM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function upstreamRequestId(request: Request): string | null {
  for (const name of ["x-request-id", "x-vercel-id"]) {
    const value = request.headers.get(name);
    if (value && UPSTREAM_ID_RE.test(value)) return value;
  }
  return null;
}

const STATUS_OUTCOMES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  413: "payload_too_large",
  422: "unprocessable",
  500: "error",
  502: "bad_gateway",
  503: "unavailable",
};

export class RequestLog {
  readonly requestId = newRequestId();
  private readonly startedAt = Date.now();
  private readonly fields: LogFields = {};

  constructor(
    readonly op: string,
    private readonly upstream: string | null
  ) {}

  // Attach correlation fields (allow-listed at write time) to this request's
  // summary line and to any events logged through it.
  set(fields: LogFields): void {
    Object.assign(this.fields, fields);
  }

  // An intermediate event inside this request, carrying its request id.
  event(level: LogLevel, event: string, fields: LogFields = {}): void {
    logEvent(level, event, { ...this.base(), ...fields });
  }

  private base(): LogFields {
    return { requestId: this.requestId, upstreamRequestId: this.upstream, op: this.op };
  }

  async finish(response: Response): Promise<Response> {
    try {
      let outcome = typeof this.fields.outcome === "string" ? this.fields.outcome : null;
      if (!outcome) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as { code?: unknown; reason?: unknown } | null;
        if (typeof body?.code === "string") outcome = body.code;
        else if (response.ok && typeof body?.reason === "string") outcome = body.reason;
        else outcome = response.ok ? "ok" : (STATUS_OUTCOMES[response.status] ?? `http_${response.status}`);
      }
      // A browse-only refusal is the demo working as intended, not a fault.
      const level: LogLevel = response.status >= 500 && outcome !== "browse_only" ? "warn" : "info";
      logEvent(level, "request", {
        ...this.fields,
        ...this.base(),
        outcome,
        status: response.status,
        durationMs: Date.now() - this.startedAt,
      });
      response.headers.set("X-Request-Id", this.requestId);
    } catch {
      // Logging must never affect the request.
    }
    return response;
  }

  failed(err: unknown): void {
    logEvent("error", "request", {
      ...this.fields,
      ...this.base(),
      outcome: "exception",
      errorKind: errorKind(err),
      durationMs: Date.now() - this.startedAt,
    });
  }
}

// Runs a route handler with a request log. Exceptions are logged (class only)
// and rethrown unchanged, so the framework's behaviour is not altered.
export async function runLogged(
  op: string,
  request: Request,
  handler: (log: RequestLog) => Promise<Response>
): Promise<Response> {
  const log = new RequestLog(op, upstreamRequestId(request));
  let response: Response;
  try {
    response = await handler(log);
  } catch (err) {
    log.failed(err);
    throw err;
  }
  return log.finish(response);
}
