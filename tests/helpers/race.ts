// A narrow command-interception helper used by ONE test: the
// double-release characterization (INV-02). It is intentionally not a
// reusable proxy framework — it exists only to force a specific
// read/read/write/write interleaving deterministically, so the race
// reproduces without timing-dependent sleeps.
//
// How it works: the app's store issues Redis commands one awaited call
// at a time, so each lands as its own single-command Upstash REST
// request. This wrapper watches the request bodies and holds the FIRST
// write that matches `writeKey` until at least `releaseAfterReads` reads
// of `readKey` have been observed — i.e. until the second concurrent
// caller has also read the pre-release state. Then both writes proceed,
// and both callers release inventory against the stale read.
//
// It wraps whatever `globalThis.fetch` is at install time (normally the
// loopback network guard) and restores it on dispose.

interface RaceOptions {
  readKey: string;
  writeCommand: "SET" | "ZREM" | "INCRBY";
  writeKey: string;
  releaseAfterReads: number;
}

interface RaceHandle {
  readsSeen: () => number;
  dispose: () => void;
}

function bodyText(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body == null) return "";
  return String(body);
}

// The Upstash client auto-pipelines, so one HTTP request body can carry
// several commands as `[["GET","k"],["SET","k","v"],...]`. Count the
// command elements, not the requests, by matching each element's
// `["VERB","key"` prefix (compact JSON, no spaces — how the client
// serializes). This keeps the read count correct whether the two
// concurrent reads land as one batched request or two separate ones.
function countCommand(text: string, verb: string, key: string): number {
  const needle = `["${verb}",${JSON.stringify(key)}`;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

export function installReadWriteRace(options: RaceOptions): RaceHandle {
  const original = globalThis.fetch;
  let reads = 0;
  let heldOnce = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const wrapped: typeof fetch = async (input, init) => {
    const text = bodyText(init);

    reads += countCommand(text, "GET", options.readKey);
    if (reads >= options.releaseAfterReads) release();

    if (!heldOnce && countCommand(text, options.writeCommand, options.writeKey) > 0) {
      heldOnce = true;
      await gate; // hold the first matching write until both reads happen
    }

    return original(input as Parameters<typeof fetch>[0], init);
  };

  globalThis.fetch = wrapped;

  return {
    readsSeen: () => reads,
    dispose: () => {
      release(); // never leave a pending write hung if the test bails
      globalThis.fetch = original;
    },
  };
}
