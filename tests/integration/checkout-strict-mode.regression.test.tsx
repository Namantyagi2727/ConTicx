// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as guestSessionRoute } from "@/app/api/guest-session/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { randomUUID } from "node:crypto";
import type { Order } from "@/lib/types";
import { getFake } from "../setup/integration";
import { TEST_APP_ORIGIN } from "../setup/constants";
import { makeTestRedis } from "../helpers/redis";

// REGRESSION — the real app/checkout page under React Strict Mode.
//
// Strict Mode runs every effect setup → cleanup → setup on the same component
// instance. Checkout's booking effect used to POST /api/orders on each setup,
// so one checkout visit reserved seats and created a provider payment TWICE,
// leaving an orphaned pending hold. This renders the actual CheckoutPage with
// react-dom inside <StrictMode>, with:
//   - the payment-widget packages replaced by the checkout-harness stubs
//     (tests/browser/checkout-harness), which record what checkout passes in;
//   - next/navigation and next/link replaced by minimal test doubles;
//   - the page's same-origin fetch() calls routed IN-PROCESS to the real
//     /api/guest-session and /api/orders route handlers, behaving like a
//     browser (cookie jar, same-origin Origin header). Those handlers use the
//     local test Redis and the fake provider exactly as in other suites.

vi.mock("@juspay-tech/hyper-js", () => import("../browser/checkout-harness/hyper-js"));
vi.mock("@juspay-tech/react-hyper-js", () => import("../browser/checkout-harness/react-hyper-js"));

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: (() => {}) as (href: string) => void,
  replaced: [] as string[],
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: nav.push, replace: (href: string) => nav.replaced.push(href) }),
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

const r = makeTestRedis();
const INV_KEY = "inventory:midnight-parade:VIP";

// ---------------------------------------------------------------------------
// Browser-like fetch: relative URLs go to the real route handlers in-process;
// absolute URLs (Upstash, the fake provider) go to the guarded real fetch.
// ---------------------------------------------------------------------------
let realFetch: typeof fetch;
let cookieJar = "";
const browserRequests: string[] = [];

async function routeRequest(method: string, path: string, req: Request): Promise<Response> {
  if (method === "POST" && path === "/api/guest-session") return guestSessionRoute(req);
  if (method === "POST" && path === "/api/orders") return createOrderRoute(req);
  return new Response("not routed in this test", { status: 404 });
}

function installBrowserFetch() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/")) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0];
    browserRequests.push(`${method} ${path}`);
    const headers = new Headers(init?.headers);
    headers.set("origin", TEST_APP_ORIGIN);
    if (cookieJar) headers.set("cookie", cookieJar);
    const res = await routeRequest(
      method,
      path,
      new Request(`${TEST_APP_ORIGIN}${url}`, { method, headers, body: init?.body })
    );
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookieJar = setCookie.split(";")[0];
    return res;
  }) as typeof fetch;
}

function count(path: string): number {
  return browserRequests.filter((r) => r === path).length;
}

function providerCreates(): number {
  return getFake().calls.filter((c) => c.method === "POST" && c.path === "/payments").length;
}

async function storedOrders(): Promise<Order[]> {
  const keys = await r.keys("order:*");
  return Promise.all(keys.map(async (k) => (await r.get<Order>(k))!));
}

// ---------------------------------------------------------------------------
// Rendering. Modules are reset per test so module-level client state (the
// shared guest-session request, the widget loader) starts fresh, the way it
// does on a new page load.
// ---------------------------------------------------------------------------
type Mounted = { container: HTMLElement; unmount: () => Promise<void> };
let act: (cb: () => unknown) => Promise<void>;

async function mountCheckout(query: string): Promise<Mounted> {
  nav.params = new URLSearchParams(query);
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: CheckoutPage } = await import("@/app/checkout/page");
  act = React.act as typeof act;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(CheckoutPage)));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const widgetShown = (m: Mounted) => m.container.querySelector('[data-testid="hyper-stub-widget"]') !== null;

// A checkout URL for one booking attempt (Phase 1B.5: the attempt id travels
// in the URL, minted by the event page's Get-tickets action).
function checkoutQuery(tier: string, quantity: number, attemptId = randomUUID()): string {
  return `eventId=midnight-parade&tierName=${tier}&quantity=${quantity}&attempt=${attemptId}`;
}

beforeEach(() => {
  vi.resetModules();
  nav.replaced.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  cookieJar = "";
  browserRequests.length = 0;
  delete window.__HYPER_STUB__;
  installBrowserFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

describe("[regression] checkout books once per checkout attempt under Strict Mode", () => {
  it("gives a URL without an attempt exactly one new attempt, and books nothing before it", async () => {
    const page = await mountCheckout("eventId=midnight-parade&tierName=VIP&quantity=1");
    await waitUntil(() => nav.replaced.length > 0, "the attempt to be written into the URL");

    // Strict Mode re-ran the effect, but the minted attempt is the same one.
    expect(new Set(nav.replaced).size).toBe(1);
    const attempt = new URL(nav.replaced[0], "http://x").searchParams.get("attempt");
    expect(attempt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(count("POST /api/orders")).toBe(0);

    await page.unmount();
  });

  it("issues one session, one booking, one payment, and renders the widget with its result", async () => {
    const attemptId = randomUUID();
    const page = await mountCheckout(checkoutQuery("VIP", 2, attemptId));
    await waitUntil(() => widgetShown(page), "the payment widget");

    // One session identity, one booking request, one provider payment.
    expect(count("POST /api/guest-session")).toBe(1);
    expect(count("POST /api/orders")).toBe(1);
    expect(providerCreates()).toBe(1);
    expect(await r.keys("guest_session:*")).toHaveLength(1);

    // One order, one inventory decrement (10 VIP seats, 2 reserved).
    const orders = await storedOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].attemptId).toBe(attemptId); // the URL's attempt was booked
    expect(await r.get(INV_KEY)).toBe(8);
    expect(await r.zcard("pending_holds")).toBe(1);

    // The surviving component got THAT booking's result: the widget was given
    // the single payment's client secret and the order's own return URL.
    const payment = getFake().getPayment(orders[0].paymentId!)!;
    expect(window.__HYPER_STUB__?.elements?.clientSecret).toBe(payment.client_secret);
    expect(window.__HYPER_STUB__?.unifiedCheckout?.walletReturnUrl).toBe(
      `${window.location.origin}/confirmation/${orders[0].id}`
    );
    expect(page.container.textContent).toContain("PAY $220.00");

    await page.unmount();
  });

  it("still makes a deliberate separate booking, under the same guest", async () => {
    const first = await mountCheckout(checkoutQuery("VIP", 2));
    await waitUntil(() => widgetShown(first), "the first widget");
    await first.unmount();

    // A new checkout visit with a NEW attempt (a fresh Get-tickets click)
    // books again.
    const second = await mountCheckout(checkoutQuery("VIP", 1));
    await waitUntil(() => widgetShown(second), "the second widget");

    expect(count("POST /api/orders")).toBe(2);
    expect(providerCreates()).toBe(2);
    const orders = await storedOrders();
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((o) => o.ownerHash)).size).toBe(1);
    expect(await r.keys("guest_session:*")).toHaveLength(1);
    expect(await r.get(INV_KEY)).toBe(7); // 10 − 2 − 1
    expect(second.container.textContent).toContain("PAY $110.00");

    await second.unmount();
  });

  it("shows a booking error once, from a single request", async () => {
    await r.set(INV_KEY, 1); // fewer seats than requested
    const page = await mountCheckout(checkoutQuery("VIP", 2));
    await waitUntil(
      () => page.container.textContent?.includes("Couldn't reserve those tickets") ?? false,
      "the error state"
    );

    expect(count("POST /api/orders")).toBe(1);
    expect(page.container.textContent).toContain("Only 1 VIP ticket(s) left");
    expect(widgetShown(page)).toBe(false);
    expect(providerCreates()).toBe(0);
    expect(await r.keys("order:*")).toEqual([]);

    await page.unmount();
  });

  it("does not book twice or error when unmounted while the booking is in flight", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await mountCheckout(checkoutQuery("VIP", 1));
    await page.unmount(); // leave before the booking resolves

    await waitUntil(async () => (await r.keys("order:*")).length === 1, "the in-flight booking");
    await waitUntil(() => providerCreates() === 1, "the provider payment");
    expect(count("POST /api/orders")).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
