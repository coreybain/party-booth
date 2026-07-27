import { describe, expect, it } from "vitest";

import { ACCOUNT_STATES, accountStateMachine, canAccountSignIn, isAccountActive } from "./accounts";
import {
  acceptsUploads,
  EVENT_STATES,
  eventStateMachine,
  isEditableEventState,
  isJoinableEventState,
  isViewableEventState,
} from "./events";
import {
  CAPTURE_STATES,
  captureStateMachine,
  MEDIA_STATES,
  mediaStateAfterProcessing,
  mediaStateForDecision,
  mediaStateMachine,
} from "./media";
import { InvalidTransitionError, type StateMachine } from "./state-machine";

/** Structural rules every lifecycle in the product must satisfy. */
function describeMachineInvariants<T extends string>(
  name: string,
  machine: StateMachine<T>,
  states: readonly T[],
): void {
  describe(`${name} — invariants`, () => {
    it("declares a transition list for every state", () => {
      expect(Object.keys(machine.transitions).sort()).toEqual([...states].sort());
    });

    it("only ever points at declared states", () => {
      for (const from of states) {
        for (const to of machine.nextStates(from)) {
          expect(states).toContain(to);
        }
      }
    });

    it("never lists a state as its own successor", () => {
      for (const from of states) {
        expect(machine.nextStates(from)).not.toContain(from);
      }
    });

    it("treats a same-state transition as a legal no-op", () => {
      // Convex mutations retry and callbacks arrive twice; idempotence is the
      // difference between a duplicate audit row and a 500 during the party.
      for (const state of states) {
        expect(machine.canTransition(state, state)).toBe(true);
        expect(() => machine.assertTransition(state, state)).not.toThrow();
      }
    });

    it("reaches every state from the first one", () => {
      const [start] = states;
      expect(start).toBeDefined();
      const seen = new Set<T>([start as T]);
      const queue: T[] = [start as T];
      while (queue.length > 0) {
        const current = queue.shift() as T;
        for (const next of machine.nextStates(current)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].sort()).toEqual([...states].sort());
    });

    it("throws a named error naming the allowed targets", () => {
      const illegal = states
        .flatMap((from) => states.map((to) => [from, to] as const))
        .find(([from, to]) => !machine.canTransition(from, to));
      expect(illegal, "every machine should have at least one illegal transition").toBeDefined();
      const [from, to] = illegal as readonly [T, T];
      expect(() => machine.assertTransition(from, to)).toThrow(InvalidTransitionError);
      try {
        machine.assertTransition(from, to);
      } catch (error) {
        expect((error as InvalidTransitionError).from).toBe(from);
        expect((error as InvalidTransitionError).to).toBe(to);
        expect((error as Error).message).toContain(from);
      }
    });
  });
}

describeMachineInvariants("Account", accountStateMachine, ACCOUNT_STATES);
describeMachineInvariants("Event", eventStateMachine, EVENT_STATES);
describeMachineInvariants("Media", mediaStateMachine, MEDIA_STATES);
describeMachineInvariants("Capture", captureStateMachine, CAPTURE_STATES);

/* -------------------------------------------------------------------------- */

describe("account lifecycle", () => {
  it("makes `deleted` the only terminal state", () => {
    expect(ACCOUNT_STATES.filter((s) => accountStateMachine.isTerminal(s))).toEqual(["deleted"]);
  });

  it("can lock, unlock and re-lock", () => {
    expect(accountStateMachine.canTransition("active", "locked")).toBe(true);
    expect(accountStateMachine.canTransition("locked", "active")).toBe(true);
  });

  it("lets a locked user still request deletion", () => {
    expect(accountStateMachine.canTransition("locked", "deletionScheduled")).toBe(true);
  });

  it("can restore a scheduled deletion, but not resurrect a purged account", () => {
    expect(accountStateMachine.canTransition("deletionScheduled", "active")).toBe(true);
    expect(accountStateMachine.canTransition("deleted", "active")).toBe(false);
  });

  it("only treats `active` as full access, but lets the others sign in", () => {
    expect(ACCOUNT_STATES.filter(isAccountActive)).toEqual(["active"]);
    expect(ACCOUNT_STATES.filter(canAccountSignIn)).toEqual([
      "active",
      "locked",
      "deletionScheduled",
    ]);
  });
});

describe("event lifecycle", () => {
  it("never jumps from draft straight to paused", () => {
    expect(eventStateMachine.canTransition("draft", "paused")).toBe(false);
  });

  it("pauses and resumes", () => {
    expect(eventStateMachine.canTransition("live", "paused")).toBe(true);
    expect(eventStateMachine.canTransition("paused", "live")).toBe(true);
  });

  it("lets an archived event be re-opened but not un-deleted into live", () => {
    expect(eventStateMachine.canTransition("archived", "live")).toBe(true);
    expect(eventStateMachine.canTransition("deletionScheduled", "live")).toBe(false);
    expect(eventStateMachine.canTransition("deletionScheduled", "archived")).toBe(true);
  });

  it("can schedule deletion from every other state", () => {
    for (const state of EVENT_STATES.filter((s) => s !== "deletionScheduled")) {
      expect(eventStateMachine.canTransition(state, "deletionScheduled")).toBe(true);
    }
  });

  it("classifies states consistently", () => {
    expect(EVENT_STATES.filter(isJoinableEventState)).toEqual(["scheduled", "live", "paused"]);
    expect(EVENT_STATES.filter(acceptsUploads)).toEqual(["live"]);
    expect(EVENT_STATES.filter(isViewableEventState)).toEqual(["live", "paused", "archived"]);
    expect(EVENT_STATES.filter(isEditableEventState)).toEqual([
      "draft",
      "scheduled",
      "live",
      "paused",
    ]);
  });

  it("accepts uploads only in a state that is also joinable and viewable", () => {
    for (const state of EVENT_STATES) {
      if (acceptsUploads(state)) {
        expect(isJoinableEventState(state)).toBe(true);
        expect(isViewableEventState(state)).toBe(true);
      }
    }
  });
});

describe("media lifecycle", () => {
  it("makes `deleted` terminal", () => {
    expect(MEDIA_STATES.filter((s) => mediaStateMachine.isTerminal(s))).toEqual(["deleted"]);
  });

  it("can be withdrawn from every live state", () => {
    for (const state of MEDIA_STATES.filter((s) => s !== "deleted")) {
      expect(mediaStateMachine.canTransition(state, "deleted")).toBe(true);
    }
  });

  it("never declines something that is still processing", () => {
    expect(mediaStateMachine.canTransition("processing", "declined")).toBe(false);
  });

  it("lets a host change their mind in both directions", () => {
    expect(mediaStateMachine.canTransition("approved", "declined")).toBe(true);
    expect(mediaStateMachine.canTransition("declined", "approved")).toBe(true);
  });

  it("routes by moderation mode after processing", () => {
    expect(mediaStateAfterProcessing("manual")).toBe("pending");
    expect(mediaStateAfterProcessing("automatic")).toBe("approved");
    // `ai` queues for a human until P1 ships the classifier.
    expect(mediaStateAfterProcessing("ai")).toBe("pending");
  });

  it("maps a decision straight onto a state", () => {
    expect(mediaStateForDecision("approved")).toBe("approved");
    expect(mediaStateForDecision("declined")).toBe("declined");
  });

  it("only ever moves to a state the machine allows, for both decisions", () => {
    for (const decision of ["approved", "declined"] as const) {
      expect(mediaStateMachine.canTransition("pending", mediaStateForDecision(decision))).toBe(
        true,
      );
    }
  });
});

describe("capture lifecycle", () => {
  it("can be undone only before the bytes leave the device", () => {
    expect(captureStateMachine.canTransition("captured", "cancelled")).toBe(true);
    expect(captureStateMachine.canTransition("queued", "cancelled")).toBe(true);
    expect(captureStateMachine.canTransition("uploaded", "cancelled")).toBe(false);
  });

  it("retries a failed upload by going back to the queue", () => {
    expect(captureStateMachine.canTransition("failed", "queued")).toBe(true);
    expect(captureStateMachine.canTransition("failed", "uploading")).toBe(false);
  });

  it("has exactly two terminal states", () => {
    expect(CAPTURE_STATES.filter((s) => captureStateMachine.isTerminal(s))).toEqual([
      "uploaded",
      "cancelled",
    ]);
  });
});
