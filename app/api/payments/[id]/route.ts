import { NextResponse } from "next/server";
import { hyperswitchFetch } from "@/lib/hyperswitch";

// Looks up the current status of a payment straight from Hyperswitch.
// The confirmation page calls this instead of trusting the client SDK —
// Hyperswitch's own backend is the source of truth for payment status.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const response = await hyperswitchFetch(`/payments/${id}`);
  const data = await response.json();

  if (!response.ok) {
    return NextResponse.json({ error: data }, { status: response.status });
  }

  return NextResponse.json({
    paymentId: data.payment_id,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
  });
}
