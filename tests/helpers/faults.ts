// Fetch-level fault injection for integration tests. Both things the app
// talks to go through the global fetch: each Redis command is its own
// Upstash REST request (the basis tests/helpers/race.ts relies on), and every
// provider call goes through lib/hyperswitch. Wrapping fetch therefore lets a
// test fail or interleave one specific command deterministically, without
// depending on module/singleton identity. Each helper returns a disposer; the
// integration setup also reinstalls the loopback guard after every test.

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function bodyOf(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "";
}

function install(wrapped: typeof fetch): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = wrapped;
  return () => {
    globalThis.fetch = previous;
  };
}

// Every Redis request whose serialized command body matches `match`
// (uppercased) fails with a non-ok JSON error. RESOLVING an error response
// (rather than rejecting) matters: the Upstash client retries a rejected
// fetch (5 attempts with backoff) but throws immediately on a non-ok
// response, so this fails deterministically and fast — surfacing in the
// store exactly like a real Redis failure.
export function failRedisCommand(match: (upperBody: string) => boolean): () => void {
  const previous = globalThis.fetch;
  return install((input, init) => {
    const body = bodyOf(init);
    if (body && match(body.toUpperCase())) {
      return Promise.resolve(
        new Response('{"error":"injected redis failure"}', {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return previous(input as FetchInput, init);
  });
}

// Every request whose URL matches `match` fails at the transport level (the
// fetch promise rejects, as for a connection reset) — the caller cannot tell
// whether the far side received it.
export function rejectRequests(match: (url: string) => boolean): () => void {
  const previous = globalThis.fetch;
  return install((input, init) => {
    if (match(urlOf(input))) return Promise.reject(new TypeError("fetch failed (injected)"));
    return previous(input as FetchInput, init);
  });
}

// Runs `hook` exactly once, immediately BEFORE forwarding the first Redis
// request whose body matches `match` — a deterministic interleaving point
// ("between the caller's read and its next command"). Requests the hook
// itself makes pass straight through.
export function beforeRedisCommandOnce(
  match: (upperBody: string) => boolean,
  hook: () => Promise<void>
): () => void {
  const previous = globalThis.fetch;
  let fired = false;
  return install(async (input, init) => {
    const body = bodyOf(init);
    if (!fired && body && match(body.toUpperCase())) {
      fired = true;
      await hook();
    }
    return previous(input as FetchInput, init);
  });
}

// Polls until `condition` holds (a deterministic barrier on observable
// state, rather than a fixed sleep).
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
