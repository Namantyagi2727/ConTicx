import { jsonNoStore, loadOwnedOrder, orderNotFound, sessionRequired, toOrderView } from "@/lib/order-access";
import { bookingEnabled, browseOnlyResponse } from "@/lib/app-mode";

// Reads one of the current guest's orders. Ownership is checked before
// anything is returned, using a side-effect-free read: no hold expiry, no
// reconciliation, no provider call. A missing order and someone else's order
// get the same 404; only allow-listed fields are returned, never cached.
// For a status that should be refreshed from the provider, use
// GET /api/orders/[id]/status.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!bookingEnabled()) return browseOnlyResponse();
  const { id } = await params;
  const lookup = await loadOwnedOrder(request, id);
  if (lookup.kind === "no_session") return sessionRequired();
  if (lookup.kind === "not_found") return orderNotFound();
  return jsonNoStore(toOrderView(lookup.order));
}
