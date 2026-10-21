// Unit-test setup: no network at all. Unit tests cover pure helpers
// (env schema, guards, the fake's own shape) and must never open a
// socket. The guard turns any fetch into an immediate throw.

import { afterAll, beforeAll } from "vitest";
import { installNetworkGuard, restoreNetworkGuard } from "./network-guard";

beforeAll(() => {
  installNetworkGuard("block-all");
});

afterAll(() => {
  restoreNetworkGuard();
});
