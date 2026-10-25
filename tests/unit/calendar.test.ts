import { describe, expect, it } from "vitest";
import { buildEventIcs, escapeIcsText, foldIcsLine, toIcsUtc } from "@/lib/calendar";
import { events, getEvent } from "@/lib/events";
import type { EventRecord } from "@/lib/types";

// "Add to calendar": the generated iCalendar content, checked against the
// RFC 5545 rules it relies on. Pure — no network, no Redis.

const NOW = new Date("2026-10-25T12:00:00Z");

function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

describe("calendar file", () => {
  it("writes the event's start instant in UTC from its offset timestamp", () => {
    // Midnight Parade: 2026-10-03T19:30:00-04:00 is 23:30 UTC.
    expect(toIcsUtc(getEvent("midnight-parade")!.date)).toBe("20261003T233000Z");
    expect(toIcsUtc("2026-09-12T19:00:00-04:00")).toBe("20260912T230000Z");
    expect(() => toIcsUtc("not a date")).toThrow();
  });

  it("contains the event, venue, and start — and no invented end", () => {
    const event = getEvent("midnight-parade")!;
    const lines = unfold(buildEventIcs(event, { tierName: "VIP", quantity: 2 }, NOW));

    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("DTSTART:20261003T233000Z");
    expect(lines).toContain("DTSTAMP:20261025T120000Z");
    expect(lines).toContain(`SUMMARY:${escapeIcsText(`${event.name} — ${event.artist}`)}`);
    expect(lines).toContain(`LOCATION:${escapeIcsText(`${event.venue}, ${event.venueAddress}`)}`);
    expect(lines.find((l) => l.startsWith("DESCRIPTION:"))).toContain("2 × VIP");
    expect(lines.some((l) => l.startsWith("DTEND") || l.startsWith("DURATION"))).toBe(false);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.at(-2)).toBe("END:VCALENDAR");
  });

  it("uses CRLF line endings and folds every line to at most 75 octets", () => {
    for (const event of events) {
      const ics = buildEventIcs(event, { tierName: "GA", quantity: 4 }, NOW);
      expect(ics.endsWith("\r\n")).toBe(true);
      expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // no bare CR or LF
      for (const physical of ics.split("\r\n")) {
        expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
      }
    }
  });

  it("escapes TEXT values and folds without splitting multi-byte characters", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");

    const long = "SUMMARY:" + "é".repeat(60); // 2 octets each
    const folded = foldIcsLine(long);
    for (const physical of folded.split("\r\n")) {
      expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("escapes catalog text that contains separators", () => {
    const event: EventRecord = {
      ...getEvent("neon-nights")!,
      name: "Back, Again; Live",
      venueAddress: "1 Main St\nUnit 2",
    };
    const lines = unfold(buildEventIcs(event, { tierName: "GA", quantity: 1 }, NOW));
    expect(lines.find((l) => l.startsWith("SUMMARY:"))).toContain("Back\\, Again\\; Live");
    expect(lines.find((l) => l.startsWith("LOCATION:"))).toContain("1 Main St\\nUnit 2");
  });

  it("carries no order id, link, or credential", () => {
    const ics = buildEventIcs(getEvent("indie-echoes")!, { tierName: "VIP", quantity: 1 }, NOW);
    expect(ics).not.toMatch(/https?:\/\//);
    expect(ics).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // order ids
    expect(ics).not.toMatch(/pay_|secret|conticx_guest/i);
    expect(unfold(ics)).toContain("UID:indie-echoes@conticx.event");
  });
});
