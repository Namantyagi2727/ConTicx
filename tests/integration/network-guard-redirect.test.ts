import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedNetworkError } from "../setup/network-guard";

// T1A-03 (redirect hardening). Verifies that the loopback-only network
// guard — installed by tests/setup/integration.ts for this suite — does
// not let a loopback response follow a 3xx redirect to another host.
// Everything here is a LOCAL fixture on 127.0.0.1: no remote service is
// ever contacted. A `/landing` endpoint records whether the client was
// redirected onto it, so the test distinguishes "redirect refused"
// (correct) from "redirect followed" (the gap this guards against).

describe("network guard: redirects are not followed off the vetted URL", () => {
  let server: Server;
  let base: string;
  let landed = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/landing") {
        landed = true;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("landed");
        return;
      }
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.url === "/redirect-loopback") {
        // Redirect to another loopback path. If the client followed it,
        // `/landing` would flip `landed` to true.
        res.writeHead(302, { Location: `${base}/landing` });
        res.end();
        return;
      }
      if (req.url === "/redirect-remote") {
        // Redirect to a non-loopback host. `.invalid` never resolves, so
        // even a regression here cannot reach a real server.
        res.writeHead(302, { Location: "https://remote.invalid/evil" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("allows a plain loopback request (control)", async () => {
    const res = await fetch(`${base}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("refuses to follow a loopback->loopback redirect (does not reach /landing)", async () => {
    landed = false;
    await expect(fetch(`${base}/redirect-loopback`)).rejects.toThrow();
    // The decisive assertion: the redirect target was never requested.
    expect(landed).toBe(false);
  });

  it("refuses to follow a loopback->remote redirect without contacting the remote host", async () => {
    // Rejects on the 3xx itself (redirect: "error"), so remote.invalid is
    // never resolved or connected to.
    await expect(fetch(`${base}/redirect-remote`)).rejects.toThrow();
  });

  it("still blocks a direct fetch to a remote host at the guard", () => {
    // Positive control for the guard's primary job: a direct remote URL
    // throws synchronously, before any socket is opened.
    expect(() => fetch("https://remote.invalid/x")).toThrow(BlockedNetworkError);
  });
});
