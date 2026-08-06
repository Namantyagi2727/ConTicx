"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_QUANTITY_PER_ORDER } from "@/lib/constants";
import { formatCents } from "@/lib/format";
import { posterColorClasses } from "@/lib/theme";
import type { EventRecord, TierAvailability } from "@/lib/types";

// A tier reads as low-stock once fewer than a fifth of its total
// inventory remains — real enough to be worth flagging, not so
// aggressive it fires on every tier the moment one ticket sells.
const LOW_STOCK_RATIO = 0.2;

export function TierPicker({
  event,
  availability,
}: {
  event: EventRecord;
  availability: TierAvailability[];
}) {
  const router = useRouter();
  const colors = posterColorClasses[event.posterColor];

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
    <div className="mt-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {availability.map((tier) => {
          const soldOut = tier.remaining === 0;
          const lowStock =
            !soldOut && tier.remaining <= tier.totalInventory * LOW_STOCK_RATIO;
          const isSelected = tierName === tier.name;

          return (
            <button
              key={tier.name}
              type="button"
              disabled={soldOut}
              onClick={() => handleTierChange(tier)}
              aria-pressed={isSelected}
              className={`group relative overflow-hidden border p-5 text-left transition-colors ${
                soldOut
                  ? "cursor-not-allowed border-ink-line opacity-40"
                  : isSelected
                    ? `${colors.border} bg-ink-raised`
                    : "border-ink-line bg-ink-raised hover:border-text-faint"
              }`}
            >
              {isSelected && !soldOut && (
                <span className={`absolute inset-x-0 top-0 h-1 ${colors.bg}`} />
              )}

              <div className="flex items-start justify-between">
                <span className="font-display text-3xl font-black tracking-tight">
                  {tier.name}
                </span>
                <span className="font-mono text-xl font-bold">
                  {formatCents(tier.priceCents)}
                </span>
              </div>

              <p className="mt-2 font-body text-sm text-text-muted">{tier.perk}</p>

              <div className="mt-4">
                {soldOut ? (
                  <span className="font-mono text-[11px] font-bold text-text-faint">
                    SOLD OUT
                  </span>
                ) : lowStock ? (
                  <span className="rounded-full bg-acid px-2 py-0.5 font-mono text-[11px] font-bold text-ink">
                    ONLY {tier.remaining} LEFT
                  </span>
                ) : (
                  <span className="font-mono text-[11px] text-text-faint">
                    {tier.remaining} available
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {maxSelectable > 0 ? (
        <div className="mt-6 flex items-center gap-4">
          <div className="flex items-center border border-ink-line">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1}
              aria-label="Decrease quantity"
              className="px-3 py-2 font-mono text-lg text-text-muted transition-colors hover:text-text disabled:opacity-30"
            >
              −
            </button>
            <span className="w-10 text-center font-mono text-lg font-bold">
              {quantity}
            </span>
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.min(maxSelectable, q + 1))}
              disabled={quantity >= maxSelectable}
              aria-label="Increase quantity"
              className="px-3 py-2 font-mono text-lg text-text-muted transition-colors hover:text-text disabled:opacity-30"
            >
              +
            </button>
          </div>

          <button
            onClick={handleBuy}
            className="flex-1 bg-flame py-3 text-center font-display text-lg font-bold tracking-wide text-ink transition-transform hover:-translate-y-0.5 active:translate-y-0"
          >
            GET TICKETS — {formatCents(selected.priceCents * quantity)}
          </button>
        </div>
      ) : (
        <p className="mt-6 font-mono text-sm text-text-faint">
          This tier is sold out.
        </p>
      )}
    </div>
  );
}
