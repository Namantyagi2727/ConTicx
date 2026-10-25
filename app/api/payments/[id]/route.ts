import { jsonNoStore } from "@/lib/order-access";

// DISABLED (Phase 1B.4). This public lookup let anyone holding a provider
// payment id read it and trigger order reconciliation. Its only caller, the
// confirmation page, now uses the guest-owned GET /api/orders/[id]/status.
// This stub calls no provider and touches no state.
export const dynamic = "force-dynamic";

export async function GET() {
  return jsonNoStore({ error: "Not available" }, 410);
}
