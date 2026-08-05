import { describe, expect, it } from "vitest";

import { EVENT_STATES, eventStateMachine, type EventState } from "./contracts";
import {
  allowedNextStates,
  END_EVENT_CONFIRMATION_SECONDS,
  EVENT_STATE_COPY,
  eventHasEnded,
  eventHasNotStarted,
  eventNowAction,
  eventStatusLine,
  formatGuestCount,
  galleryIsVisible,
  groupJoinCode,
  guestsCanJoin,
  guestsCanUpload,
  LIVE_ENDING_IMMINENT_MS,
  LIVE_ENDING_SOON_MS,
  liveEventTiming,
  STATE_ACTION_LABELS,
  tickEndEventConfirmation,
} from "./event-view";

/**
 * The console must never offer a button Convex will refuse, and must never
 * claim a guest can do something the contract says they cannot. Both are
 * checked against `@partybooth/contracts` rather than against a second copy of
 * the rules written here.
 */

describe("EVENT_STATE_COPY", () => {
  it("has a label for every state the backend can return", () => {
    for (const state of EVENT_STATES) {
      expect(EVENT_STATE_COPY[state].label.length).toBeGreaterThan(0);
      expect(EVENT_STATE_COPY[state].description.length).toBeGreaterThan(0);
    }
  });
});

describe("allowedNextStates", () => {
  it("offers exactly the transitions the state machine permits", () => {
    for (const from of EVENT_STATES) {
      for (const to of allowedNextStates(from)) {
        expect(eventStateMachine.canTransition(from, to)).toBe(true);
      }
    }
  });

  it("never offers the current state — that button would do nothing", () => {
    for (const from of EVENT_STATES) {
      expect(allowedNextStates(from)).not.toContain(from);
    }
  });

  it("never offers deletion, which has to go through the deletion flow", () => {
    for (const from of EVENT_STATES) {
      expect(allowedNextStates(from)).not.toContain("deletionScheduled");
    }
  });

  it("offers the after-party: archived can go back to live", () => {
    expect(allowedNextStates("archived")).toContain("live");
  });

  it("has an action label for every state it can offer", () => {
    for (const from of EVENT_STATES) {
      for (const to of allowedNextStates(from)) {
        expect(STATE_ACTION_LABELS[to]).toBeDefined();
      }
    }
  });
});

describe("capability helpers", () => {
  it("lets guests in exactly while the code is meant to work", () => {
    const joinable = EVENT_STATES.filter((state: EventState) => guestsCanJoin(state));
    expect(joinable).toEqual(["scheduled", "live", "paused"]);
  });

  it("accepts uploads only while live", () => {
    const uploadable = EVENT_STATES.filter((state: EventState) => guestsCanUpload(state));
    expect(uploadable).toEqual(["live"]);
  });

  it("keeps the gallery visible after the party", () => {
    const viewable = EVENT_STATES.filter((state: EventState) => galleryIsVisible(state));
    expect(viewable).toEqual(["live", "paused", "archived"]);
  });
});

describe("eventStatusLine", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0);

  it("tells a scheduled host that the code already works", () => {
    const line = eventStatusLine({ state: "scheduled", startsAt: now + 3 * 86_400_000 }, now);
    expect(line).toContain("guests can join now");
  });

  it("warns when a live event has run past its end time", () => {
    const line = eventStatusLine(
      { state: "live", startsAt: now - 86_400_000, endsAt: now - 3_600_000 },
      now,
    );
    expect(line).toContain("archive");
  });

  it("falls back to the state's own description", () => {
    expect(eventStatusLine({ state: "draft", startsAt: now }, now)).toBe(
      EVENT_STATE_COPY.draft.description,
    );
  });
});

describe("eventHasEnded", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0);

  it("marks a scheduled end in the past as ended", () => {
    expect(eventHasEnded({ endsAt: now - 1 }, now)).toBe(true);
  });

  it("keeps future and open-ended events current", () => {
    expect(eventHasEnded({ endsAt: now + 1 }, now)).toBe(false);
    expect(eventHasEnded({}, now)).toBe(false);
  });
});

describe("eventHasNotStarted", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0);

  it("distinguishes a future start from a current or past one", () => {
    expect(eventHasNotStarted({ startsAt: now + 1 }, now)).toBe(true);
    expect(eventHasNotStarted({ startsAt: now }, now)).toBe(false);
    expect(eventHasNotStarted({ startsAt: now - 1 }, now)).toBe(false);
  });
});

describe("eventNowAction", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0);

  it("keeps Start now available for a live event scheduled in the future", () => {
    expect(eventNowAction({ state: "live", startsAt: now + 1 }, now)).toBe("start");
  });

  it("offers End now only after a live event has reached its start", () => {
    expect(eventNowAction({ state: "live", startsAt: now }, now)).toBe("end");
    expect(eventNowAction({ state: "live", startsAt: now - 1 }, now)).toBe("end");
  });

  it("does not offer an immediate schedule action for a closed event", () => {
    expect(eventNowAction({ state: "archived", startsAt: now - 1 }, now)).toBeUndefined();
  });
});

describe("liveEventTiming", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0);

  it("keeps future-live events distinct from end-time warnings", () => {
    expect(
      liveEventTiming(
        { state: "live", startsAt: now + 1, endsAt: now + LIVE_ENDING_IMMINENT_MS },
        now,
      ),
    ).toBe("future");
  });

  it("uses the normal live treatment until the final two hours", () => {
    expect(
      liveEventTiming(
        { state: "live", startsAt: now - 1, endsAt: now + LIVE_ENDING_SOON_MS + 1 },
        now,
      ),
    ).toBe("normal");
    expect(liveEventTiming({ state: "live", startsAt: now - 1 }, now)).toBe("normal");
  });

  it("warns during the final two hours and escalates during the final 30 minutes", () => {
    expect(
      liveEventTiming(
        { state: "live", startsAt: now - 1, endsAt: now + LIVE_ENDING_SOON_MS },
        now,
      ),
    ).toBe("soon");
    expect(
      liveEventTiming(
        { state: "live", startsAt: now - 1, endsAt: now + LIVE_ENDING_IMMINENT_MS },
        now,
      ),
    ).toBe("imminent");
  });
});

describe("end-event confirmation countdown", () => {
  it("counts down to an automatic reset", () => {
    let remaining: number | undefined = END_EVENT_CONFIRMATION_SECONDS;
    const seen: Array<number | undefined> = [];

    for (let tick = 0; tick < END_EVENT_CONFIRMATION_SECONDS; tick += 1) {
      remaining = tickEndEventConfirmation(remaining);
      seen.push(remaining);
    }

    expect(seen).toEqual([4, 3, 2, 1, undefined]);
  });

  it("keeps a disarmed confirmation disarmed", () => {
    expect(tickEndEventConfirmation(undefined)).toBeUndefined();
  });
});

describe("formatGuestCount", () => {
  it("counts the host out, because the host is not a guest", () => {
    expect(formatGuestCount(1)).toBe("0 guests");
    expect(formatGuestCount(2)).toBe("1 guest");
    expect(formatGuestCount(13)).toBe("12 guests");
  });

  it("never goes negative on an event with no membership rows yet", () => {
    expect(formatGuestCount(0)).toBe("0 guests");
  });
});

describe("groupJoinCode", () => {
  it("splits six digits so they can be read across a noisy room", () => {
    expect(groupJoinCode("482913")).toBe("482 913");
  });

  it("leaves anything that is not six digits alone", () => {
    expect(groupJoinCode("4829")).toBe("4829");
  });
});
