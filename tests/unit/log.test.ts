import { afterEach, describe, expect, it, vi } from "vitest";
import { errorKind, logEvent, newRequestId, runLogged } from "@/lib/log";

// Structured logging helpers: field allow-listing, error handling, request
// ids, and the guarantee that logging cannot change a response.

afterEach(() => vi.restoreAllMocks());

function captured(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

describe("logEvent", () => {
  it("writes one JSON line with only allow-listed primitive fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("info", "test.event", {
      orderId: "o-1",
      durationMs: 12,
      cookie: "conticx_guest=secret",
      ownerHash: "a".repeat(64),
      clientSecret: "pay_x_secret_y",
      authorization: "Bearer x",
      body: { nested: true },
      attemptId: "a-1",
      reason: "x".repeat(500),
    });
    const [line] = captured(spy);
    expect(line).toMatchObject({ level: "info", event: "test.event", orderId: "o-1", durationMs: 12 });
    for (const key of ["cookie", "ownerHash", "clientSecret", "authorization", "body", "attemptId"]) {
      expect(line).not.toHaveProperty(key);
    }
    expect(String(line.reason)).toHaveLength(200);
  });

  it("routes warn and error to the matching console method", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("warn", "w");
    logEvent("error", "e");
    expect(captured(warn)[0].event).toBe("w");
    expect(captured(error)[0].event).toBe("e");
  });

  it("never throws, even if the console does", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() => logEvent("info", "x")).not.toThrow();
  });

  it("names an error by class only, never its message", () => {
    const err = new TypeError('command was: [["eval", "{\\"ownerHash\\":\\"abc\\"}"]]');
    expect(errorKind(err)).toBe("TypeError");
    expect(errorKind("string thrown")).toBe("unknown");
  });
});

describe("request correlation", () => {
  it("generates distinct server request ids", () => {
    const a = newRequestId();
    expect(a).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    expect(newRequestId()).not.toBe(a);
  });

  it("logs one summary line, returns X-Request-Id, and keeps only a valid upstream id", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await runLogged(
      "test.op",
      new Request("http://x/", { headers: { "x-request-id": "edge-123:abc" } }),
      async (log) => {
        log.set({ orderId: "o-9" });
        return Response.json({ code: "ready" });
      }
    );
    const bad = await runLogged(
      "test.op",
      new Request("http://x/", { headers: { "x-request-id": "<script>" + "x".repeat(300) } }),
      async () => Response.json({}, { status: 404 })
    );
    const [first, second] = captured(spy);

    expect(first).toMatchObject({
      event: "request",
      op: "test.op",
      outcome: "ready",
      status: 200,
      orderId: "o-9",
      upstreamRequestId: "edge-123:abc",
    });
    expect(typeof first.durationMs).toBe("number");
    expect(ok.headers.get("x-request-id")).toBe(first.requestId);
    expect(first.requestId).not.toBe("edge-123:abc");
    expect(second).toMatchObject({ outcome: "not_found", status: 404, upstreamRequestId: null });
    expect(bad.headers.get("x-request-id")).toBe(second.requestId);
  });

  it("returns the handler's response unchanged when logging fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    const res = await runLogged("test.op", new Request("http://x/"), async () =>
      Response.json({ code: "ready" }, { status: 201 })
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ code: "ready" });
  });

  it("logs an exception by class and rethrows it unchanged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new RangeError("secret detail");
    await expect(
      runLogged("test.op", new Request("http://x/"), async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    const [line] = captured(spy);
    expect(line).toMatchObject({ outcome: "exception", errorKind: "RangeError" });
    expect(JSON.stringify(line)).not.toContain("secret detail");
  });
});
