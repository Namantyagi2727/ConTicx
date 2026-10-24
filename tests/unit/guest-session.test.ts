import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRequestOrigin, trustedOrigin } from "@/lib/app-origin";
import {
  guestCookieName,
  hashGuestCredential,
  ownsOrder,
  readGuestCredential,
  serializeGuestCookie,
} from "@/lib/guest-session";

// Pure helpers behind Phase 1B.4 guest ownership: trusted-origin parsing,
// cookie attributes in an HTTPS deployment, credential parsing, and the
// ownership comparison. No network, no Redis.

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.APP_ORIGIN;
});
afterEach(() => {
  process.env.APP_ORIGIN = saved;
});

function withOrigin(header: string | null): Request {
  const headers: Record<string, string> = {};
  if (header !== null) headers.origin = header;
  return new Request("https://tickets.example/api/orders", { method: "POST", headers });
}

describe("trusted origin configuration", () => {
  it("accepts only a bare http(s) origin", () => {
    const cases: [string | undefined, string | null][] = [
      ["https://tickets.example", "https://tickets.example"],
      ["https://tickets.example/", "https://tickets.example"],
      ["http://localhost:3000", "http://localhost:3000"],
      [undefined, null],
      ["", null],
      ["tickets.example", null],
      ["https://tickets.example/app", null],
      ["https://tickets.example?x=1", null],
      ["https://user:pw@tickets.example", null],
      ["ftp://tickets.example", null],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = value;
      expect(trustedOrigin(), String(value)).toBe(expected);
    }
  });

  it("matches the Origin header exactly and rejects everything else", () => {
    process.env.APP_ORIGIN = "https://tickets.example";
    expect(checkRequestOrigin(withOrigin("https://tickets.example"))).toEqual({ ok: true });
    const rejected: [string | null, string][] = [
      [null, "missing"],
      ["", "missing"],
      ["null", "malformed"],
      ["garbage", "malformed"],
      ["https://tickets.example/", "malformed"],
      ["https://TICKETS.example", "malformed"],
      ["http://tickets.example", "foreign"],
      ["https://tickets.example:8443", "foreign"],
      ["https://evil.example", "foreign"],
    ];
    for (const [header, reason] of rejected) {
      expect(checkRequestOrigin(withOrigin(header)), String(header)).toEqual({ ok: false, reason });
    }
  });

  it("reports an unconfigured origin rather than accepting any", () => {
    delete process.env.APP_ORIGIN;
    expect(checkRequestOrigin(withOrigin("https://tickets.example"))).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });
});

describe("guest cookie", () => {
  const credential = "A".repeat(43);

  it("is Secure with the __Host- prefix under an https origin", () => {
    process.env.APP_ORIGIN = "https://tickets.example";
    const cookie = serializeGuestCookie(credential);
    expect(guestCookieName()).toBe("__Host-conticx_guest");
    expect(cookie.startsWith(`__Host-conticx_guest=${credential};`)).toBe(true);
    const attrs = cookie.split(";").map((a) => a.trim());
    expect(attrs).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]));
    expect(attrs.some((a) => a.toLowerCase().startsWith("domain"))).toBe(false);
  });

  it("reads only a well-formed credential under the configured name", () => {
    process.env.APP_ORIGIN = "https://tickets.example";
    const req = (cookie: string) =>
      new Request("https://tickets.example/", { headers: { cookie } });
    expect(readGuestCredential(req(`a=1; __Host-conticx_guest=${credential}`))).toBe(credential);
    expect(readGuestCredential(req(`conticx_guest=${credential}`))).toBeNull(); // wrong name for https
    expect(readGuestCredential(req("__Host-conticx_guest=short"))).toBeNull();
    expect(readGuestCredential(req(`__Host-conticx_guest=${credential}!`))).toBeNull();
  });
});

describe("ownership comparison", () => {
  const owner = hashGuestCredential("B".repeat(43));

  it("matches only an identical owner hash", () => {
    expect(ownsOrder({ ownerHash: owner }, owner)).toBe(true);
    expect(ownsOrder({ ownerHash: hashGuestCredential("C".repeat(43)) }, owner)).toBe(false);
  });

  it("never matches a legacy order or a malformed hash", () => {
    expect(ownsOrder({}, owner)).toBe(false);
    expect(ownsOrder({ ownerHash: "" }, owner)).toBe(false);
    expect(ownsOrder({ ownerHash: owner.toUpperCase() }, owner.toUpperCase())).toBe(false);
  });
});
