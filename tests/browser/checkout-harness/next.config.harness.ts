import type { NextConfig } from "next";

// Test-only Next config for the checkout browser harness (run.sh). run.sh
// copies it over next.config.ts in a DISPOSABLE export of the repository —
// the real next.config.ts and the production build never see it. It swaps
// the two payment-widget packages for local stubs at the import boundary,
// so the real app/checkout page runs unmodified without loading anything
// from Hyperswitch.
const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "@juspay-tech/hyper-js": "./tests/browser/checkout-harness/hyper-js.ts",
      "@juspay-tech/react-hyper-js": "./tests/browser/checkout-harness/react-hyper-js.tsx",
    },
  },
};

export default nextConfig;
