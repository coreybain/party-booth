import { describe, expect, it } from "vitest";

import {
  eventAcceptsUploads,
  EVENT_STATES,
  eventJoinability,
  eventStateMachine,
  HOST_SETTABLE_EVENT_STATES,
  isHostSettableEventState,
  isJoinableEventState,
  isWithinJoinWindow,
  JOIN_WINDOW,
  joinWindowStatus,
  type EventState,
} from "./events";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("host-settable states", () => {
  it("offers every state except deletionScheduled", () => {
    expect([...HOST_SETTABLE_EVENT_STATES].sort()).toEqual(
      EVENT_STATES.filter((state) => state !== "deletionScheduled").sort(),
    );
  });

  it("reserves deletionScheduled for the deletion flow", () => {
    // Reaching it has to go through the code that also writes a `deletionJobs`
    // row, or the 30-day restore window is unreachable.
    expect(isHostSettableEventState("deletionScheduled")).toBe(false);
  });

  it.each(HOST_SETTABLE_EVENT_STATES)("accepts %s", (state) => {
    expect(isHostSettableEventState(state)).toBe(true);
  });
});

describe("eventAcceptsUploads", () => {
  it("opens a scheduled event at its pre-event upload boundary", () => {
    const event = { state: "scheduled" as const, uploadStartsAt: T0 - HOUR };
    expect(eventAcceptsUploads(event, T0 - HOUR - 1)).toBe(false);
    expect(eventAcceptsUploads(event, T0 - HOUR)).toBe(true);
  });

  it("keeps live open and pause or archive closed regardless of the timestamp", () => {
    expect(eventAcceptsUploads({ state: "live" }, T0)).toBe(true);
    expect(eventAcceptsUploads({ state: "paused", uploadStartsAt: T0 - HOUR }, T0)).toBe(false);
    expect(eventAcceptsUploads({ state: "archived", uploadStartsAt: T0 - HOUR }, T0)).toBe(false);
  });
});

describe("joinWindowStatus", () => {
  it("is open during the party", () => {
    expect(joinWindowStatus({ startsAt: T0, endsAt: T0 + 6 * HOUR }, T0 + HOUR)).toBe("open");
  });

  it("is open before the doors, so printed signage works", () => {
    expect(joinWindowStatus({ startsAt: T0 }, T0 - 2 * 24 * HOUR)).toBe("open");
  });

  it("is too early for a party that is not for months", () => {
    expect(joinWindowStatus({ startsAt: T0 }, T0 - JOIN_WINDOW.opensBeforeStartMs - 1)).toBe(
      "tooEarly",
    );
  });

  it("stays open exactly at the early boundary", () => {
    expect(joinWindowStatus({ startsAt: T0 }, T0 - JOIN_WINDOW.opensBeforeStartMs)).toBe("open");
  });

  it("keeps the door open through the grace period", () => {
    const endsAt = T0 + 6 * HOUR;
    expect(joinWindowStatus({ startsAt: T0, endsAt }, endsAt + HOUR)).toBe("open");
    expect(joinWindowStatus({ startsAt: T0, endsAt }, endsAt + JOIN_WINDOW.closesAfterEndMs)).toBe(
      "open",
    );
  });

  it("closes once the grace period has passed", () => {
    const endsAt = T0 + 6 * HOUR;
    expect(
      joinWindowStatus({ startsAt: T0, endsAt }, endsAt + JOIN_WINDOW.closesAfterEndMs + 1),
    ).toBe("closed");
  });

  it("never closes an open-ended event on time alone", () => {
    // No `endsAt` means only the host archiving it ends the party.
    expect(isWithinJoinWindow({ startsAt: T0 }, T0 + 365 * 24 * HOUR)).toBe(true);
  });
});

describe("eventJoinability", () => {
  it.each(EVENT_STATES)("refuses %s when it is not a joinable state", (state) => {
    const verdict = eventJoinability({ state, startsAt: T0 }, T0);
    if (isJoinableEventState(state)) {
      expect(verdict.joinable).toBe(true);
    } else {
      expect(verdict).toEqual({ joinable: false, reason: "eventNotJoinable" });
    }
  });

  it("distinguishes a closed window from a wrong state, for the audit log", () => {
    const endsAt = T0 + HOUR;
    expect(
      eventJoinability(
        { state: "live", startsAt: T0, endsAt },
        endsAt + JOIN_WINDOW.closesAfterEndMs + 1,
      ),
    ).toEqual({ joinable: false, reason: "outsideWindow" });
  });

  it("checks the state before the clock", () => {
    // A draft event with a perfectly good schedule is still not joinable, and
    // the reason recorded should say so.
    expect(eventJoinability({ state: "draft", startsAt: T0 }, T0)).toEqual({
      joinable: false,
      reason: "eventNotJoinable",
    });
  });
});

describe("the state machine and the host switch agree", () => {
  it("lets a host reach every host-settable state from somewhere", () => {
    for (const target of HOST_SETTABLE_EVENT_STATES) {
      const reachable = EVENT_STATES.some(
        (from: EventState) => from !== target && eventStateMachine.canTransition(from, target),
      );
      expect(reachable, `nothing can move to ${target}`).toBe(true);
    }
  });

  it("allows the after-party — archived back to live", () => {
    expect(eventStateMachine.canTransition("archived", "live")).toBe(true);
  });

  it("refuses to un-delete an event into a live one", () => {
    expect(eventStateMachine.canTransition("deletionScheduled", "live")).toBe(false);
  });
});
