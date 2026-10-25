import { jsonNoStore } from "@/lib/order-access";

// DISABLED (Phase 1B.4). An early prototype endpoint that created a fixed
// $50 payment intent for anyone, unrelated to any order. Nothing in the app
// calls it (checkout creates payments through POST /api/orders). This stub
// calls no provider and touches no state.
export const dynamic = "force-dynamic";

export async function POST() {
  return jsonNoStore({ error: "Not available" }, 410);
}
