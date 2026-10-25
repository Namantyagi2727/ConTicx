// Shared recorder for the payment-widget stubs (test-only; used by the
// checkout browser harness, never by the application build). Everything the
// checkout page hands the widget is recorded on window.__HYPER_STUB__ so a
// browser check can read the integration contract back, and each event is
// also logged to the console with a "[hyper-stub]" prefix.

export type StubMode = "success" | "decline" | "redirect";

export interface StubRecord {
  loadHyper?: { publishableKeyPrefix: string; env: unknown };
  elements?: { clientSecret: unknown; hasAppearance: boolean; hyperIsPromise: boolean };
  unifiedCheckout?: { id: unknown; walletReturnUrl: unknown };
  confirmPayment?: { returnUrl: unknown; redirect: unknown; receivedWidgets: boolean };
  events: string[];
}

declare global {
  interface Window {
    __HYPER_STUB__?: StubRecord;
  }
}

export function stubRecord(): StubRecord {
  if (typeof window === "undefined") return { events: [] };
  window.__HYPER_STUB__ ??= { events: [] };
  return window.__HYPER_STUB__;
}

export function stubEvent(name: string, detail?: unknown): void {
  const record = stubRecord();
  record.events.push(name);
  console.info(`[hyper-stub] ${name}`, detail ?? "");
}

// The behaviour confirmPayment simulates, chosen per browser via
// localStorage.hyperStubMode (default "success").
export function stubMode(): StubMode {
  try {
    const mode = window.localStorage.getItem("hyperStubMode");
    if (mode === "decline" || mode === "redirect") return mode;
  } catch {
    // storage unavailable: fall through to the default
  }
  return "success";
}
