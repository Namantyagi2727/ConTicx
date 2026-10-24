import { notFound } from "next/navigation";

// The organizer view is DISABLED (Phase 1B.4). It had no authentication —
// the unlinked URL was its only protection — while showing sales and revenue
// figures and running hold expiry (and therefore provider calls) on every
// view. There is no admin login yet, so the page answers 404 for everyone
// and reads nothing. A protected organizer view is deferred.
export const dynamic = "force-dynamic";

export default function AdminPage() {
  notFound();
}
