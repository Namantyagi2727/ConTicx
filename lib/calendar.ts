// "Add to calendar" for a confirmed ticket: an RFC 5545 iCalendar file built
// from the event catalog, generated in the browser from ticket data the page
// is already authorized to show.
//
// What goes in, and why:
//   DTSTART      the event's start instant, from its ISO-8601 timestamp with
//                UTC offset, written in UTC ("...Z"). A UTC time is
//                unambiguous, so no TZID/VTIMEZONE is needed and calendar
//                apps show it in the viewer's own zone.
//   (no DTEND)   the catalog has no end time or duration, and none is
//                invented. Per RFC 5545 §3.6.1, a DATE-TIME DTSTART without
//                DTEND or DURATION is an event at that instant.
//   SUMMARY, LOCATION, DESCRIPTION
//                event, artist, venue and address, doors offset, age
//                restriction, and the ticket's tier and quantity — all TEXT,
//                escaped per §3.3.11.
//   UID          derived from the event id only.
// Deliberately absent: order ids, URLs, guest credentials, payment ids, and
// anything else that is private or could grant access.

import type { EventRecord } from "./types";

const CRLF = "\r\n";

// RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, newline.
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 §3.1: content lines SHOULD be at most 75 octets (excluding the
// line break); longer lines are folded with CRLF + one space. Folding counts
// UTF-8 octets and never splits a multi-byte character.
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    if (currentBytes + bytes > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
      limit = 74; // continuation lines start with a space
    }
    current += ch;
    currentBytes += bytes;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

// 2026-10-03T19:30:00-04:00 -> 20261003T233000Z. Refuses anything that does
// not parse to a real instant rather than writing a wrong time.
export function toIcsUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid event date: ${iso}`);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface CalendarTicket {
  tierName: string;
  quantity: number;
}

export function buildEventIcs(
  event: EventRecord,
  ticket: CalendarTicket,
  now: Date = new Date()
): string {
  const description = [
    `Doors open ${event.doorsMinutesBeforeShow} minutes before the show.`,
    `Ages ${event.ageRestriction}.`,
    `Your tickets: ${ticket.quantity} × ${ticket.tierName}.`,
    "Booked on ConTicx (demo).",
  ].join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ConTicx//Tickets//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@conticx.event`,
    `DTSTAMP:${toIcsUtc(now.toISOString())}`,
    `DTSTART:${toIcsUtc(event.date)}`,
    `SUMMARY:${escapeIcsText(`${event.name} — ${event.artist}`)}`,
    `LOCATION:${escapeIcsText(`${event.venue}, ${event.venueAddress}`)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

export function icsFileName(event: EventRecord): string {
  return `${event.id}.ics`;
}
