import { afterEach, describe, expect, it } from "vitest";
import {
  BlockedNetworkError,
  installNetworkGuard,
  isBlocked,
  restoreNetworkGuard,
} from "../setup/network-guard";

// T1A-03 (part) / T1A-08 backing. The decision logic is tested as a pure
// function (no sockets). We also confirm an installed guard throws
// synchronously for a disallowed host — again without contacting it.

afterEach(() => {
  restoreNetworkGuard();
  installNetworkGuard("block-all"); // restore the unit-suite default
});

describe("isBlocked", () => {
  it("block-all blocks every host, loopback included", () => {
    expect(isBlocked("http://127.0.0.1:38079/ping", "block-all")).toBe(true);
    expect(isBlocked("http://localhost/x", "block-all")).toBe(true);
  });

  it("loopback-only blocks remote hosts", () => {
    expect(isBlocked("https://fancy-cat-1234.upstash.io", "loopback-only")).toBe(true);
    expect(isBlocked("https://sandbox.hyperswitch.io/payments", "loopback-only")).toBe(true);
    expect(isBlocked("http://10.0.0.5:38079", "loopback-only")).toBe(true);
  });

  it("loopback-only allows loopback hosts", () => {
    expect(isBlocked("http://127.0.0.1:38079/ping", "loopback-only")).toBe(false);
    expect(isBlocked("http://localhost:38171/payments", "loopback-only")).toBe(false);
    expect(isBlocked("http://[::1]:38079", "loopback-only")).toBe(false);
  });
});

describe("installed guard", () => {
  it("throws synchronously for a disallowed host without connecting", () => {
    installNetworkGuard("loopback-only");
    expect(() => fetch("https://sandbox.hyperswitch.io/payments")).toThrow(BlockedNetworkError);
  });

  it("block-all throws even for loopback", () => {
    installNetworkGuard("block-all");
    expect(() => fetch("http://127.0.0.1:38079/ping")).toThrow(BlockedNetworkError);
  });
});
