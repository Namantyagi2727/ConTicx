import { jsonNoStore } from "@/lib/order-access";

// Online refunds are DISABLED (Phase 1B.4). The previous handler let anyone
// who knew an order id refund it (audit finding SEC-02) and had no safe
// handling of duplicate or asynchronous provider refunds. Until the
// dedicated refund phase adds guest authorization and duplicate-safe
// provider calls, this endpoint does nothing: it reads no order, calls no
// provider, and changes no state.
export const dynamic = "force-dynamic";

export async function POST() {
  return jsonNoStore({ error: "Online refunds are not available." }, 503);
}
