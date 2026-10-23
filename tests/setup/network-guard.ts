// Wraps the process-global `fetch` so test code can never make a real
// outbound request by accident. This guards the `fetch` transport only:
// it is NOT an OS-level or all-transport firewall. It covers the
// application's outbound paths because both things the app talks to —
// Upstash (via @upstash/redis) and Hyperswitch (via lib/hyperswitch's
// `hyperswitchFetch`) — use the global `fetch` and nothing else. A
// dependency that reached the network through a raw socket (node:net,
// node:http/https, a native addon) would bypass this wrapper; nothing on
// the exercised paths does, but the guard is not proof that nothing
// else could.
//
// Two modes:
//   - "block-all" (unit tests): every fetch throws. Unit tests must not
//     touch any network, real or local.
//   - "loopback-only" (integration tests): only 127.0.0.1 / localhost /
//     [::1] are allowed through to the real `fetch`; anything else
//     throws before a connection is attempted. Allowed requests are
//     additionally forced to `redirect: "error"` so a loopback response
//     cannot bounce the client to a remote host via a 3xx redirect (the
//     guard only vets the initial URL; `fetch` follows redirects by
//     default).
//
// This is a safety net, not the primary isolation mechanism — the
// target guard (target-guard.ts) and vitest's `test.env` already point
// the app at local endpoints. The guard exists so that if a new code
// path or a misconfiguration ever aimed at a remote host, the test
// fails loudly instead of reaching out.

import { LOOPBACK_HOSTS } from "./constants";

type FetchInput = Parameters<typeof fetch>[0];

export class BlockedNetworkError extends Error {
  constructor(url: string, mode: GuardMode) {
    super(
      `[network-guard] blocked a ${mode} fetch to ${url}. Tests must not ` +
        `make real outbound requests; use the local fake or loopback test services.`
    );
    this.name = "BlockedNetworkError";
  }
}

export type GuardMode = "block-all" | "loopback-only";

function urlFromInput(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function hostIsLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    // A relative or unparseable URL never reaches a remote host through
    // fetch in these tests, so treat it as local rather than failing.
    return true;
  }
}

// Pure decision function, exported so it can be unit-tested directly
// without installing anything or opening a socket.
export function isBlocked(url: string, mode: GuardMode): boolean {
  return mode === "block-all" || !hostIsLoopback(url);
}

// The real fetch, captured once so restore always returns to it
// regardless of how many times the guard is (re)installed.
let base: typeof fetch | null = null;

export function installNetworkGuard(mode: GuardMode): void {
  if (!base) base = globalThis.fetch;
  const realFetch = base;

  const guarded: typeof fetch = (input: FetchInput, init?: RequestInit) => {
    const url = urlFromInput(input);
    if (isBlocked(url, mode)) {
      throw new BlockedNetworkError(url, mode);
    }
    // Only the initial URL was vetted above. Force `redirect: "error"`
    // so the real `fetch` cannot transparently follow a 3xx from a
    // loopback service to a remote host. The exercised services never
    // redirect, so this is a no-op on the happy path; an unexpected
    // redirect throws here instead of leaving loopback unseen.
    return realFetch(input as Parameters<typeof fetch>[0], {
      ...init,
      redirect: "error",
    });
  };

  globalThis.fetch = guarded;
}

export function restoreNetworkGuard(): void {
  if (base) globalThis.fetch = base;
}
