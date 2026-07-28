import { describe, expect, it } from "vitest";

import {
  formatRelative,
  formatSchedule,
  isKnownTimeZone,
  timestampToZonedInput,
  timeZoneAbbreviation,
  timeZoneOptions,
  zonedInputToTimestamp,
} from "./datetime";

/**
 * The wall-clock ↔ epoch conversion is the one place in the console where being
 * an hour out is silent and expensive: it moves the doors of the party, and the
 * host has no way to tell from the form that it happened.
 */

describe("zonedInputToTimestamp", () => {
  it("reads the typed time in the event's zone, not the machine's", () => {
    // 20:00 in London on 5 August 2026 is British Summer Time, i.e. 19:00 UTC.
    expect(zonedInputToTimestamp("2026-08-05T20:00", "Europe/London")).toBe(
      Date.UTC(2026, 7, 5, 19, 0),
    );
    // The same wall clock in New York is four hours behind UTC in August.
    expect(zonedInputToTimestamp("2026-08-05T20:00", "America/New_York")).toBe(
      Date.UTC(2026, 7, 6, 0, 0),
    );
    expect(zonedInputToTimestamp("2026-08-05T20:00", "UTC")).toBe(Date.UTC(2026, 7, 5, 20, 0));
  });

  it("uses the offset that applies on the day, not today's", () => {
    // Winter: London is on GMT, so the wall clock is UTC.
    expect(zonedInputToTimestamp("2026-01-05T20:00", "Europe/London")).toBe(
      Date.UTC(2026, 0, 5, 20, 0),
    );
  });

  it("survives the daylight-saving boundaries in both directions", () => {
    // The hour 01:00–02:00 does not exist on 29 March 2026 in London; a time
    // inside it resolves forward, which is what every calendar app does.
    const springForward = zonedInputToTimestamp("2026-03-29T01:30", "Europe/London");
    expect(springForward).toBeDefined();
    // 02:00 BST is 01:00 UTC on that day.
    expect(zonedInputToTimestamp("2026-03-29T02:00", "Europe/London")).toBe(
      Date.UTC(2026, 2, 29, 1, 0),
    );
    // Autumn: 01:30 happens twice; either instant is acceptable, but it must
    // be one of them rather than NaN.
    const fallBack = zonedInputToTimestamp("2026-10-25T01:30", "Europe/London");
    expect(fallBack).toBeDefined();
    expect(Number.isFinite(fallBack)).toBe(true);
  });

  it("round-trips through the input format", () => {
    for (const zone of ["Europe/London", "America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
      const timestamp = zonedInputToTimestamp("2026-08-05T20:00", zone);
      expect(timestamp).toBeDefined();
      expect(timestampToZonedInput(timestamp as number, zone)).toBe("2026-08-05T20:00");
    }
  });

  it("returns undefined rather than a wrong instant", () => {
    expect(zonedInputToTimestamp("", "Europe/London")).toBeUndefined();
    expect(zonedInputToTimestamp("not a date", "Europe/London")).toBeUndefined();
    expect(zonedInputToTimestamp("2026-08-05", "Europe/London")).toBeUndefined();
    expect(zonedInputToTimestamp("2026-08-05T20:00", "Mars/Olympus_Mons")).toBeUndefined();
  });

  it("accepts the seconds some browsers add to a datetime-local value", () => {
    expect(zonedInputToTimestamp("2026-08-05T20:00:00", "UTC")).toBe(Date.UTC(2026, 7, 5, 20, 0));
  });
});

describe("isKnownTimeZone", () => {
  it("separates real IANA names from typos", () => {
    expect(isKnownTimeZone("Europe/London")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Europe/Londn")).toBe(false);
  });
});

describe("formatSchedule", () => {
  const startsAt = Date.UTC(2026, 7, 5, 19, 0); // 20:00 in London

  it("shows the event's zone, not the reader's", () => {
    expect(formatSchedule(startsAt, undefined, "Europe/London")).toContain("20:00");
    expect(formatSchedule(startsAt, undefined, "UTC")).toContain("19:00");
  });

  it("drops the repeated date when the night ends the same day", () => {
    const endsAt = startsAt + 3 * 60 * 60 * 1000; // 23:00 London
    const line = formatSchedule(startsAt, endsAt, "Europe/London");
    expect(line).toBe("Wed 5 Aug, 20:00 – 23:00");
  });

  it("keeps both dates when the party runs past midnight", () => {
    const endsAt = startsAt + 8 * 60 * 60 * 1000; // 04:00 the next day
    const line = formatSchedule(startsAt, endsAt, "Europe/London");
    expect(line).toContain("Thu 6 Aug");
  });

  it("shows only the start when the event is open-ended", () => {
    expect(formatSchedule(startsAt, undefined, "Europe/London")).not.toContain("–");
  });
});

describe("timeZoneAbbreviation", () => {
  it("distinguishes summer from winter, which is the whole point of showing it", () => {
    expect(timeZoneAbbreviation(Date.UTC(2026, 7, 5, 19, 0), "Europe/London")).toBe("GMT+1");
    expect(timeZoneAbbreviation(Date.UTC(2026, 0, 5, 20, 0), "Europe/London")).toBe("GMT");
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0);

  it("picks a unit a human would use", () => {
    expect(formatRelative(now + 30_000, now)).toMatch(/second/);
    expect(formatRelative(now + 45 * 60_000, now)).toMatch(/minute/);
    expect(formatRelative(now + 5 * 3_600_000, now)).toMatch(/hour/);
    expect(formatRelative(now + 3 * 86_400_000, now)).toMatch(/day/);
    expect(formatRelative(now - 2 * 86_400_000, now)).toMatch(/ago|yesterday/);
  });
});

describe("timeZoneOptions", () => {
  it("pins the host's own zone to the top without duplicating it", () => {
    const options = timeZoneOptions("Asia/Tokyo");
    expect(options[0]).toBe("Asia/Tokyo");
    expect(options.filter((zone) => zone === "Asia/Tokyo")).toHaveLength(1);
  });

  it("silently drops a zone the runtime does not know", () => {
    expect(timeZoneOptions("Mars/Olympus_Mons")).not.toContain("Mars/Olympus_Mons");
  });
});
