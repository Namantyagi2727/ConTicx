import { NextResponse } from "next/server";
import { hyperswitchFetch } from "@/lib/hyperswitch";

// Creates a Hyperswitch payment intent and hands the browser back just
// enough to mount the checkout widget (client_secret + payment_id).
// confirm stays false — the widget confirms the payment once the
// shopper enters their card details.
export async function POST() {
  const response = await hyperswitchFetch("/payments", {
    method: "POST",
    body: JSON.stringify({
      amount: 5000, // $50.00 in cents — fixed test amount, no storefront yet
      currency: "USD",
      confirm: false,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return NextResponse.json({ error: data }, { status: response.status });
  }

  return NextResponse.json({
    clientSecret: data.client_secret,
    paymentId: data.payment_id,
  });
}
