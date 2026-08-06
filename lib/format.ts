export function formatCents(cents: number, currency = "USD"): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency });
}

export function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDoorsTime(iso: string, minutesBeforeShow: number): string {
  const doors = new Date(new Date(iso).getTime() - minutesBeforeShow * 60_000);
  return formatTime(doors.toISOString());
}

// Three-piece date stamp for the ticket-stub-style layouts.
export function formatDateStamp(iso: string): {
  weekday: string;
  month: string;
  day: string;
} {
  const date = new Date(iso);
  return {
    weekday: date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
    month: date.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
    day: date.toLocaleDateString("en-US", { day: "numeric" }),
  };
}
