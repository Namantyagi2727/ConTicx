// Test-only stand-in for "@juspay-tech/hyper-js", aliased in by
// next.config.harness.ts. The real package injects Hyperswitch's hosted
// HyperLoader.js from a Hyperswitch domain; this stub loads nothing over the
// network and only records how checkout called it.

import { stubEvent, stubRecord } from "./stub-recorder";

export interface StubHyper {
  __stub: true;
}

export function loadHyper(publishableKey: string, options?: { env?: unknown }): Promise<StubHyper> {
  stubRecord().loadHyper = {
    // Prefix only: enough to show which key family was passed.
    publishableKeyPrefix: String(publishableKey).slice(0, 7),
    env: options?.env,
  };
  stubEvent("loadHyper");
  return Promise.resolve({ __stub: true });
}
