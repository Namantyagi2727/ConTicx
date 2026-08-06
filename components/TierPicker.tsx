"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_QUANTITY_PER_ORDER } from "@/lib/constants";
import { formatCents } from "@/lib/format";
import type { EventRecord, TierAvailability } from "@/lib/types";

export function TierPicker({
  event,
  availability,
}: {
  event: EventRecord;
  availability: TierAvailability[];
}) {
  const router = useRouter();
  const firstAvailable = availability.find((t) => t.remaining > 0);
  const [tierName, setTierName] = useState(
    firstAvailable?.name ?? availability[0].name
  );

  const selected = availability.find((t) => t.name === tierName)!;
  const maxSelectable = Math.min(MAX_QUANTITY_PER_ORDER, selected.remaining);
  const [quantity, setQuantity] = useState(maxSelectable > 0 ? 1 : 0);

  function handleTierChange(tier: TierAvailability) {
    setTierName(tier.name);
    setQuantity(tier.remaining > 0 ? 1 : 0);
  }

  function handleBuy() {
    router.push(
      `/checkout?eventId=${event.id}&tierName=${tierName}&quantity=${quantity}`
    );
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="space-y-2">
        {availability.map((tier) => {
          const soldOut = tier.remaining === 0;
          return (
            <label
              key={tier.name}
              className={`flex cursor-pointer items-center justify-between rounded-md border p-3 ${
                soldOut ? "cursor-not-allowed opacity-50" : ""
              } ${tierName === tier.name ? "border-black" : "border-gray-200"}`}
            >
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name="tier"
                  checked={tierName === tier.name}
                  disabled={soldOut}
                  onChange={() => handleTierChange(tier)}
                />
                <span>
                  <span className="font-medium">{tier.name}</span>{" "}
                  <span className="text-gray-500">
                    {formatCents(tier.priceCents)}
                  </span>
                </span>
              </span>
              <span className="text-sm text-gray-500">
                {soldOut ? "Sold out" : `${tier.remaining} left`}
              </span>
            </label>
          );
        })}
      </div>

      {maxSelectable > 0 ? (
        <div className="flex items-center gap-3">
          <label htmlFor="quantity" className="text-sm text-gray-600">
            Quantity
          </label>
          <select
            id="quantity"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="rounded-md border border-gray-300 px-2 py-1"
          >
            {Array.from({ length: maxSelectable }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            onClick={handleBuy}
            className="ml-auto rounded-md bg-black px-4 py-2 text-white"
          >
            Get tickets
          </button>
        </div>
      ) : (
        <p className="text-sm text-gray-500">This tier is sold out.</p>
      )}
    </div>
  );
}
