import { events } from "@/lib/events";
import { getRemainingInventory } from "@/lib/store";
import { SERVICE_FEE_RATE } from "@/lib/constants";
import { formatCents } from "@/lib/format";
import type { EventRecord } from "@/lib/types";

// Internal organizer view — intentionally not linked from anywhere on
// the customer-facing site. No auth on it (matches the rest of this
// prototype's scope: no accounts anywhere), so treat the URL itself
// as the only thing keeping it "private."
export const dynamic = "force-dynamic";

interface TierRow {
  tierName: string;
  reserved: number;
  total: number;
  remaining: number;
  ticketRevenueCents: number;
  feeRevenueCents: number;
}

async function tierRowsFor(event: EventRecord): Promise<TierRow[]> {
  return Promise.all(
    event.tiers.map(async (tier) => {
      const remaining = await getRemainingInventory(
        event.id,
        tier.name,
        tier.totalInventory
      );
      const reserved = tier.totalInventory - remaining;
      const ticketRevenueCents = reserved * tier.priceCents;
      const feeRevenueCents = Math.round(ticketRevenueCents * SERVICE_FEE_RATE);
      return {
        tierName: tier.name,
        reserved,
        total: tier.totalInventory,
        remaining,
        ticketRevenueCents,
        feeRevenueCents,
      };
    })
  );
}

export default async function AdminPage() {
  const eventRows = await Promise.all(
    events.map(async (event) => ({ event, tiers: await tierRowsFor(event) }))
  );

  const allTiers = eventRows.flatMap((row) => row.tiers);
  const grandReserved = allTiers.reduce((sum, t) => sum + t.reserved, 0);
  const grandTicketRevenue = allTiers.reduce((sum, t) => sum + t.ticketRevenueCents, 0);
  const grandFeeRevenue = allTiers.reduce((sum, t) => sum + t.feeRevenueCents, 0);

  return (
    <main className="flex-1 px-6 py-10 sm:px-10">
      <div className="mx-auto max-w-3xl">
        <p className="font-mono text-xs text-text-faint">
          INTERNAL — NOT LINKED FROM THE CUSTOMER SITE
        </p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">
          ORGANIZER VIEW
        </h1>
        <p className="mt-3 max-w-xl font-body text-sm leading-relaxed text-text-muted">
          Live counts, read straight from the same inventory store checkout
          uses — nothing here is a separate report that can drift out of
          sync. &quot;Reserved&quot; includes tickets still mid-checkout,
          not only confirmed sales: a hold that hasn&apos;t expired yet
          counts here, so this can run a little ahead of what&apos;s
          actually been paid for.
        </p>

        <div className="mt-8 grid grid-cols-3 gap-px overflow-hidden border border-ink-line bg-ink-line">
          <div className="bg-ink-raised px-4 py-3">
            <p className="font-mono text-[10px] text-text-faint">RESERVED</p>
            <p className="mt-1 font-mono text-xl font-bold">{grandReserved}</p>
          </div>
          <div className="bg-ink-raised px-4 py-3">
            <p className="font-mono text-[10px] text-text-faint">TICKET REVENUE</p>
            <p className="mt-1 font-mono text-xl font-bold">
              {formatCents(grandTicketRevenue)}
            </p>
          </div>
          <div className="bg-ink-raised px-4 py-3">
            <p className="font-mono text-[10px] text-text-faint">FEE REVENUE</p>
            <p className="mt-1 font-mono text-xl font-bold text-flame">
              {formatCents(grandFeeRevenue)}
            </p>
          </div>
        </div>

        <div className="mt-10 space-y-8">
          {eventRows.map(({ event, tiers }) => (
            <section key={event.id}>
              <h2 className="font-display text-xl font-extrabold tracking-tight">
                {event.name}
              </h2>
              <div className="mt-3 overflow-x-auto border border-ink-line">
                <table className="w-full min-w-[480px] border-collapse font-mono text-xs">
                  <thead>
                    <tr className="border-b border-ink-line bg-ink-raised text-text-faint">
                      <th className="px-3 py-2 text-left font-normal">TIER</th>
                      <th className="px-3 py-2 text-right font-normal">
                        RESERVED
                      </th>
                      <th className="px-3 py-2 text-right font-normal">
                        REMAINING
                      </th>
                      <th className="px-3 py-2 text-right font-normal">
                        TICKET REV.
                      </th>
                      <th className="px-3 py-2 text-right font-normal">
                        FEE REV.
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tiers.map((tier) => (
                      <tr
                        key={tier.tierName}
                        className="border-b border-ink-line bg-ink-raised last:border-b-0"
                      >
                        <td className="px-3 py-2 font-bold">{tier.tierName}</td>
                        <td className="px-3 py-2 text-right">
                          {tier.reserved} / {tier.total}
                        </td>
                        <td className="px-3 py-2 text-right">{tier.remaining}</td>
                        <td className="px-3 py-2 text-right">
                          {formatCents(tier.ticketRevenueCents)}
                        </td>
                        <td className="px-3 py-2 text-right text-flame">
                          {formatCents(tier.feeRevenueCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
