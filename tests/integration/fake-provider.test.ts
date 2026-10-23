import { describe, expect, it } from "vitest";
import { TEST_HYPERSWITCH_API_KEY, TEST_HYPERSWITCH_BASE_URL } from "../setup/constants";
import { getFake } from "../setup/integration";

// Minimal harness sanity for the fake provider — just enough to trust
// the knobs the characterization tests rely on (a 200 create, a cancel
// that can be rejected with 400, a programmable refund status). This is
// deliberately small; it is not a provider-contract suite, and real
// sandbox contract checks stay deferred (addendum S1–S10).

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(`${TEST_HYPERSWITCH_BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", "api-key": TEST_HYPERSWITCH_API_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe("fake Hyperswitch (harness sanity)", () => {
  it("creates and retrieves a payment", async () => {
    const created = await call("/payments", "POST", { amount: 4950, currency: "USD" });
    expect(created.status).toBe(200);
    expect(created.data.payment_id).toMatch(/^pay_/);
    expect(created.data.client_secret).toContain("_secret_");

    const fetched = await call(`/payments/${created.data.payment_id}`, "GET");
    expect(fetched.status).toBe(200);
    expect(fetched.data.amount).toBe(4950);
  });

  it("cancels successfully by default and returns 400 when the knob is set", async () => {
    const created = await call("/payments", "POST", { amount: 100, currency: "USD" });
    const ok = await call(`/payments/${created.data.payment_id}/cancel`, "POST", {});
    expect(ok.status).toBe(200);

    getFake().cancelRejectsWith400 = true;
    const rejected = await call(`/payments/${created.data.payment_id}/cancel`, "POST", {});
    expect(rejected.status).toBe(400);
  });

  it("returns the programmed refund status", async () => {
    getFake().refundStatus = "pending";
    const refund = await call("/refunds", "POST", { payment_id: "pay_x", amount: 100 });
    expect(refund.status).toBe(200);
    expect(refund.data.status).toBe("pending");
    expect(refund.data.refund_id).toMatch(/^ref_/);
  });
});
