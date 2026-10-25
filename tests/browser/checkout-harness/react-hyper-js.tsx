"use client";

// Test-only stand-in for "@juspay-tech/react-hyper-js", aliased in by
// next.config.harness.ts. It implements just the surface app/checkout uses —
// HyperElements, UnifiedCheckout, useHyper, useWidgets — and records what the
// page passes across that boundary (client secret, wallet return URL,
// confirmPayment parameters). confirmPayment simulates one of three widget
// outcomes chosen by localStorage.hyperStubMode:
//   success  (default) resolves with no error, as an in-page card
//            confirmation does, leaving navigation to the page;
//   decline  resolves with an error, as a declined card does;
//   redirect navigates to the page's return_url with provider-style query
//            parameters appended, as a 3DS or wallet redirect does.
// It proves nothing about the real widget, the hosted iframe, or Hyperswitch.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { stubEvent, stubMode, stubRecord } from "./stub-recorder";

interface StubContext {
  hyper: unknown;
  clientSecret: string;
}

const Ctx = createContext<StubContext | null>(null);

export function HyperElements({
  options,
  hyper,
  children,
}: {
  options: { clientSecret?: string; appearance?: unknown };
  hyper: Promise<unknown> | null;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<unknown>(null);

  useEffect(() => {
    stubRecord().elements = {
      clientSecret: options.clientSecret,
      hasAppearance: options.appearance !== undefined,
      hyperIsPromise: typeof (hyper as Promise<unknown> | null)?.then === "function",
    };
    stubEvent("HyperElements", { clientSecret: options.clientSecret });
    let cancelled = false;
    Promise.resolve(hyper).then((h) => {
      if (!cancelled) setLoaded(h);
    });
    return () => {
      cancelled = true;
    };
  }, [options.clientSecret, options.appearance, hyper]);

  return (
    <Ctx.Provider value={loaded ? { hyper: loaded, clientSecret: options.clientSecret ?? "" } : null}>
      {children}
    </Ctx.Provider>
  );
}

export function UnifiedCheckout({
  id,
  options,
}: {
  id?: string;
  options?: { wallets?: { walletReturnUrl?: string } };
}) {
  useEffect(() => {
    stubRecord().unifiedCheckout = { id, walletReturnUrl: options?.wallets?.walletReturnUrl };
    stubEvent("UnifiedCheckout", { walletReturnUrl: options?.wallets?.walletReturnUrl });
  }, [id, options]);

  return (
    <div
      id={id}
      data-testid="hyper-stub-widget"
      className="border border-dashed border-ink-line p-4 font-mono text-xs text-text-muted"
    >
      TEST PAYMENT WIDGET (STUB) — no card fields, no network.
    </div>
  );
}

export function useWidgets(): { __stubWidgets: true } | null {
  return useContext(Ctx) ? { __stubWidgets: true } : null;
}

export function useHyper() {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return {
    async confirmPayment(params: {
      elements?: unknown;
      confirmParams?: { return_url?: string };
      redirect?: string;
    }) {
      const returnUrl = params.confirmParams?.return_url;
      stubRecord().confirmPayment = {
        returnUrl,
        redirect: params.redirect,
        receivedWidgets: Boolean((params.elements as { __stubWidgets?: boolean })?.__stubWidgets),
      };
      const mode = stubMode();
      stubEvent(`confirmPayment:${mode}`, { returnUrl });

      if (mode === "decline") {
        return { error: { message: "Your card was declined. (stub)" } };
      }
      if (mode === "redirect" && returnUrl) {
        const url = new URL(returnUrl);
        url.searchParams.set("payment_intent_client_secret", ctx.clientSecret);
        url.searchParams.set("status", "processing");
        window.location.assign(url.toString());
        return new Promise<never>(() => {});
      }
      return {};
    },
  };
}
