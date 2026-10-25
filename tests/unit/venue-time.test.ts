import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "@/app/page";
import EventPage from "@/app/events/[id]/page";
import { Ticket } from "@/components/Ticket";
import { buildEventIcs } from "@/lib/calendar";
import { events, getEvent } from "@/lib/events";
import { formatDateStamp, formatDoorsTime, formatTime } from "@/lib/format";
import type { EventRecord, OrderView } from "@/lib/types";

// REGRESSION — v0.1.1: event dates and times are shown in the venue's IANA
// time zone. They used to follow the process default, so the UTC Vercel
// server rendered Indie Echoes (Sun Sep 20, 8:00 PM in Brooklyn) as
// "MON SEP 21", show 12:00 AM. Pure — no network, no Redis.

const NY = "America/New_York";

// The event page's tier picker calls useRouter(); there is no mounted app
// router when a page is rendered directly.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
}));

// Venue wall-clock facts, written out from the catalog's own timestamps
// (date + doors offset), not computed by the code under test.
const EXPECTED: Record<string, { stamp: string; doors: string; show: string }> = {
  "neon-nights": { stamp: "SAT SEP 12", doors: "6:00 PM", show: "7:00 PM" },
  "indie-echoes": { stamp: "SUN SEP 20", doors: "7:15 PM", show: "8:00 PM" },
  "midnight-parade": { stamp: "SAT OCT 3", doors: "6:30 PM", show: "7:30 PM" },
};

// The process default zone is switched per test to prove it is never used.
const ORIGINAL_TZ = process.env.TZ;
function setDefaultZone(zone: string) {
  process.env.TZ = zone;
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
}
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function stampOf(event: EventRecord): string {
  const s = formatDateStamp(event.date, event.venueTimeZone);
  return `${s.weekday} ${s.month} ${s.day}`;
}

function textOf(html: string): string {
  return html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("[regression] venue-time display", () => {
  it("shows each catalog event's venue date and times on a UTC server", () => {
    setDefaultZone("UTC");
    for (const event of events) {
      const want = EXPECTED[event.id];
      expect(stampOf(event)).toBe(want.stamp);
      expect(formatDoorsTime(event.date, event.doorsMinutesBeforeShow, event.venueTimeZone)).toBe(want.doors);
      expect(formatTime(event.date, event.venueTimeZone)).toBe(want.show);
    }
  });

  it("keeps the venue date for a show that falls on the next UTC date", () => {
    setDefaultZone("UTC");
    const event = getEvent("indie-echoes")!;
    // Precondition: in UTC this instant is already the next day.
    expect(new Date(event.date).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(stampOf(event)).toBe("SUN SEP 20");
    expect(formatTime(event.date, event.venueTimeZone)).toBe("8:00 PM");
  });

  it("does not depend on the process default zone at all", () => {
    for (const zone of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Tokyo"]) {
      setDefaultZone(zone);
      for (const event of events) {
        expect(stampOf(event)).toBe(EXPECTED[event.id].stamp);
        expect(formatTime(event.date, event.venueTimeZone)).toBe(EXPECTED[event.id].show);
      }
    }
  });

  it("applies the venue zone's daylight-saving rules for each instant", () => {
    setDefaultZone("UTC");
    // The same UTC wall time is 8 PM in winter (EST) and 9 PM in summer (EDT).
    expect(formatTime("2026-01-16T01:00:00Z", NY)).toBe("8:00 PM");
    expect(formatTime("2026-07-16T01:00:00Z", NY)).toBe("9:00 PM");
    expect(formatDateStamp("2026-01-16T01:00:00Z", NY)).toEqual({ weekday: "THU", month: "JAN", day: "15" });

    // Doors an hour before a show across the spring-forward gap
    // (2026-03-08, 2:00 AM EST → 3:00 AM EDT): elapsed time, not wall time.
    expect(formatDoorsTime("2026-03-08T03:30:00-04:00", 60, NY)).toBe("1:30 AM");
    expect(formatTime("2026-03-08T03:30:00-04:00", NY)).toBe("3:30 AM");
    // ...and across fall-back (2026-11-01, 2:00 AM EDT → 1:00 AM EST).
    expect(formatDoorsTime("2026-11-01T01:30:00-05:00", 60, NY)).toBe("1:30 AM");
  });

  it("gives every catalog event a valid IANA zone that agrees with its timestamp's offset", () => {
    for (const event of events) {
      const offset = new Intl.DateTimeFormat("en-US", {
        timeZone: event.venueTimeZone,
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date(event.date))
        .find((p) => p.type === "timeZoneName")!.value; // e.g. "GMT-04:00"
      expect(event.date.endsWith(offset.replace("GMT", ""))).toBe(true);
    }
  });

  it("leaves the calendar file's UTC start instant unchanged", () => {
    for (const zone of ["UTC", "Asia/Tokyo"]) {
      setDefaultZone(zone);
      const ics = buildEventIcs(getEvent("indie-echoes")!, { tierName: "GA", quantity: 1 }, new Date(0));
      expect(ics).toContain("DTSTART:20260921T000000Z");
      expect(ics).not.toMatch(/TZID|VTIMEZONE/);
    }
  });
});

describe("[regression] venue-time display in rendered pages (UTC server)", () => {
  beforeEach(() => {
    setDefaultZone("UTC");
    process.env.CONTICX_MODE = "browse-only"; // the pages read no inventory
  });
  afterEach(() => {
    process.env.CONTICX_MODE = "full";
  });

  it("home cards show venue dates", () => {
    const text = textOf(renderToStaticMarkup(Home()));
    expect(text).toContain("SUN SEP 20");
    expect(text).not.toContain("SEP 21");
  });

  it("event pages show venue date, doors, and show times", async () => {
    for (const event of events) {
      const want = EXPECTED[event.id];
      const page = await EventPage({ params: Promise.resolve({ id: event.id }) });
      const text = textOf(renderToStaticMarkup(page));
      expect(text).toContain(want.stamp);
      expect(text).toContain(`DOORS ${want.doors}`);
      expect(text).toContain(`SHOW ${want.show}`);
    }
  });

  it("tickets show venue date, doors, and show times", () => {
    const order: OrderView = {
      id: "00000000-0000-4000-8000-000000000000",
      eventId: "indie-echoes",
      tierName: "GA",
      quantity: 1,
      unitPriceCents: 3500,
      feeCents: 0,
      amountCents: 3500,
      currency: "USD",
      status: "succeeded",
      holdExpiresAt: 0,
      createdAt: 0,
    };
    const text = textOf(renderToStaticMarkup(createElement(Ticket, { order })));
    expect(text).toContain("SUN SEP 20 · DOORS 7:15 PM · SHOW 8:00 PM · WARSAW");
  });
});
