import { EVENT_STATES } from "@partybooth/contracts/events";
import { describe, expect, it } from "vitest";

import {
  areEventsLoading,
  describeEvent,
  describeEventState,
  describeJoinWindow,
  describeSchedule,
  eventHasEnded,
  formatEventDateTime,
  isPastEvent,
  resolveActiveEvent,
  sortEvents,
} from "./events";

import type { EventSummary } from "./api";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 5, 20, 0, 0); // 5 Aug 2026, 20:00 UTC — party night.

function event(overrides: Partial<EventSummary> & { id: string }): EventSummary {
  return {
    name: "A party",
    state: "live",
    moderationMode: "manual",
    startsAt: NOW,
    timeZone: "Europe/London",
    allowLibraryImport: false,
    publicGalleryEnabled: false,
    storageRegion: "pdx1",
    role: "guest",
    counts: { pending: 0, approved: 0, declined: 0, total: 0 },
    ...overrides,
    photoChallengesEnabled: overrides.photoChallengesEnabled ?? false,
  };
}

describe("describeEventState", () => {
  it("has copy for every state the contract defines", () => {
    // A missing entry would render `undefined` in the header, which is how a guest
    // ends up staring at a blank badge instead of "Paused".
    for (const state of EVENT_STATES) {
      const description = describeEventState(state);
      expect(description.label.length).toBeGreaterThan(0);
      expect(description.detail.length).toBeGreaterThan(0);
    }
  });

  it("takes 'can I send a photo' from the contract, not from its own copy", () => {
    expect(describeEventState("live").acceptsUploads).toBe(true);
    for (const state of ["draft", "scheduled", "paused", "archived"] as const) {
      expect(describeEventState(state).acceptsUploads).toBe(false);
    }
  });

  it("keeps the gallery available after the party ends", () => {
    expect(describeEventState("archived").viewable).toBe(true);
    expect(describeEventState("draft").viewable).toBe(false);
  });
});

describe("schedule-aware event presentation", () => {
  it("opens a scheduled camera at the pre-event upload boundary", () => {
    const scheduled = event({
      id: "pre-event",
      state: "scheduled",
      startsAt: NOW + DAY,
      uploadStartsAt: NOW,
    });

    expect(describeEvent(scheduled, NOW - 1)).toMatchObject({
      label: "Not open yet",
      acceptsUploads: false,
    });
    expect(describeEvent(scheduled, NOW)).toMatchObject({
      label: "Photos open",
      acceptsUploads: true,
    });
  });

  it("calls a live event past once its scheduled end has passed", () => {
    const finished = event({ id: "past", startsAt: NOW - DAY, endsAt: NOW - 1 });

    expect(eventHasEnded(finished, NOW)).toBe(true);
    expect(describeEvent(finished, NOW)).toMatchObject({
      label: "Past event",
      acceptsUploads: false,
      viewable: true,
      tone: "closed",
    });
  });

  it("keeps the event live through its exact scheduled end", () => {
    const endingNow = event({ id: "ending", startsAt: NOW - DAY, endsAt: NOW });

    expect(eventHasEnded(endingNow, NOW)).toBe(false);
    expect(describeEvent(endingNow, NOW)).toMatchObject({
      label: "Live",
      acceptsUploads: true,
    });
  });

  it("treats an archived event as past even when it had no scheduled end", () => {
    const archived = event({ id: "archived", state: "archived" });

    expect(isPastEvent(archived, NOW)).toBe(true);
    expect(describeEvent(archived, NOW).label).toBe("Past event");
  });
});

describe("areEventsLoading", () => {
  it("loads while Convex auth or an authenticated party query is pending", () => {
    expect(
      areEventsLoading({
        signedIn: true,
        convexAuthLoading: true,
        convexAuthenticated: false,
        events: undefined,
      }),
    ).toBe(true);
    expect(
      areEventsLoading({
        signedIn: true,
        convexAuthLoading: false,
        convexAuthenticated: true,
        events: undefined,
      }),
    ).toBe(true);
  });

  it("stops when Convex has settled unauthenticated instead of spinning forever", () => {
    expect(
      areEventsLoading({
        signedIn: true,
        convexAuthLoading: false,
        convexAuthenticated: false,
        events: undefined,
      }),
    ).toBe(false);
  });

  it("treats an empty result as loaded", () => {
    expect(
      areEventsLoading({
        signedIn: true,
        convexAuthLoading: false,
        convexAuthenticated: true,
        events: [],
      }),
    ).toBe(false);
  });
});

describe("formatEventDateTime", () => {
  it("formats in the event's own time zone, not the device's", () => {
    const london = formatEventDateTime(NOW, "Europe/London");
    const auckland = formatEventDateTime(NOW, "Pacific/Auckland");
    expect(london.inEventTimeZone).toBe(true);
    expect(auckland.inEventTimeZone).toBe(true);
    // Same instant, two clocks: a guest who flew in must not be told the wrong hour.
    expect(london.text).not.toBe(auckland.text);
  });

  it("falls back to the device clock rather than throwing on a bad zone", () => {
    // A stored time zone is host input, and Hermes ships a partial `Intl`. A blank
    // screen on party night is a worse failure than a wrong-but-labelled time.
    const result = formatEventDateTime(NOW, "Not/AZone");
    expect(result.inEventTimeZone).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe("describeSchedule", () => {
  it("distinguishes upcoming, running and finished", () => {
    const upcoming = event({ id: "a", startsAt: NOW + DAY });
    const running = event({ id: "b", startsAt: NOW - 60_000 });
    const finished = event({ id: "c", startsAt: NOW - 2 * DAY, endsAt: NOW - DAY });

    expect(describeSchedule(upcoming, NOW)).toMatch(/^Starts /);
    expect(describeSchedule(running, NOW)).toMatch(/^Started /);
    expect(describeSchedule(finished, NOW)).toMatch(/^Ended /);
  });

  it("says whose clock it used when the event's own time zone was unusable", () => {
    const broken = event({ id: "a", startsAt: NOW + DAY, timeZone: "Not/AZone" });
    expect(describeSchedule(broken, NOW)).toContain("(your time)");
  });
});

describe("describeJoinWindow", () => {
  it("is silent while the window is open — no obstacle, nothing to say", () => {
    expect(describeJoinWindow({ startsAt: NOW + DAY, timeZone: "UTC" }, NOW)).toBeNull();
    expect(describeJoinWindow({ startsAt: NOW - DAY, timeZone: "UTC" }, NOW)).toBeNull();
  });

  it("explains a party that is still too far off for its invite to work", () => {
    // `JOIN_WINDOW.opensBeforeStartMs` is 30 days, so 60 is safely outside it.
    const note = describeJoinWindow({ startsAt: NOW + 60 * DAY, timeZone: "UTC" }, NOW);
    expect(note).not.toBeNull();
    expect(note).toContain("starts working closer to the party");
  });

  it("explains a party whose window has closed", () => {
    const note = describeJoinWindow(
      { startsAt: NOW - 5 * DAY, endsAt: NOW - 4 * DAY, timeZone: "UTC" },
      NOW,
    );
    expect(note).toBe("This party has finished, so its invite has closed.");
  });
});

describe("sortEvents", () => {
  it("puts the newest party first", () => {
    const sorted = sortEvents([
      event({ id: "old", startsAt: NOW - 10 * DAY }),
      event({ id: "new", startsAt: NOW }),
      event({ id: "mid", startsAt: NOW - DAY }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks ties on name so the order never flickers between renders", () => {
    const sorted = sortEvents([
      event({ id: "b", name: "Bravo" }),
      event({ id: "a", name: "Alpha" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [event({ id: "a", startsAt: NOW - DAY }), event({ id: "b", startsAt: NOW })];
    sortEvents(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("resolveActiveEvent", () => {
  const events = [
    event({ id: "older", startsAt: NOW - 10 * DAY }),
    event({ id: "newest", startsAt: NOW }),
  ];

  it("honours the server's choice even when it is not the newest party", () => {
    expect(resolveActiveEvent(events, "older")?.id).toBe("older");
  });

  it("falls back to the newest party when nothing is selected", () => {
    expect(resolveActiveEvent(events, null)?.id).toBe("newest");
    expect(resolveActiveEvent(events, undefined)?.id).toBe("newest");
  });

  it("falls back rather than showing nothing when the selection has gone stale", () => {
    // A revoked membership or an archived party leaves the stored id pointing at
    // something no longer in the list. Being stuck on a party you cannot use is worse
    // than being moved to one you can.
    expect(resolveActiveEvent(events, "deleted-event")?.id).toBe("newest");
  });

  it("returns null when this account is in no parties at all", () => {
    expect(resolveActiveEvent([], "anything")).toBeNull();
    expect(resolveActiveEvent([], null)).toBeNull();
  });
});
