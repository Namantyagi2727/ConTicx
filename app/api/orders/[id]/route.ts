import { NextResponse } from "next/server";
import { getOrder } from "@/lib/store";

// Reads an order straight from the in-memory store. The confirmation
// page uses this as its authoritative source — it reflects
// webhook-driven status updates, not just whatever the browser saw
// right after redirect — and polls it briefly while a payment is
// still "pending".
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const order = await getOrder(id);

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  return NextResponse.json(order);
}
