export function formatCents(cents: number, currency = "USD"): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency });
}

// Event dates and times are always shown in the venue's own time zone (an
// IANA name from the catalog, e.g. "America/New_York"), never the server's
// or the browser's default: the home and event pages render on a UTC server,
// and a ticket should read the same wherever it is opened. The zone's rules
// supply the UTC offset — including daylight saving — for each instant, so
// the stored instant itself is never shifted.

export function formatEventDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
}

export function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

export function formatDoorsTime(iso: string, minutesBeforeShow: number, timeZone: string): string {
  const doors = new Date(new Date(iso).getTime() - minutesBeforeShow * 60_000);
  return formatTime(doors.toISOString(), timeZone);
}

// Three-piece date stamp for the ticket-stub-style layouts.
export function formatDateStamp(iso: string, timeZone: string): {
  weekday: string;
  month: string;
  day: string;
} {
  const date = new Date(iso);
  return {
    weekday: date.toLocaleDateString("en-US", { weekday: "short", timeZone }).toUpperCase(),
    month: date.toLocaleDateString("en-US", { month: "short", timeZone }).toUpperCase(),
    day: date.toLocaleDateString("en-US", { day: "numeric", timeZone }),
  };
}
