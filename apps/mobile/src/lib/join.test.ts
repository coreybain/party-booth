import { JOIN_REJECTED_MESSAGE, JOIN_THROTTLED_MESSAGE } from "@partybooth/contracts/join";
import { describe, expect, it } from "vitest";

import {
  describeJoinFailure,
  formatRetryAfter,
  JOIN_CODE_LENGTH,
  parseJoinResult,
  readCodeInput,
} from "./join";

describe("readCodeInput", () => {
  it("keeps a plain six-digit code", () => {
    expect(readCodeInput("428913")).toEqual({ digits: "428913", complete: true, error: null });
  });

  it("strips everything a printed sign and a phone keyboard put in the way", () => {
    // Spaces, hyphens and a non-breaking space are all things a paste brings with it.
    expect(readCodeInput("428 913").digits).toBe("428913");
    expect(readCodeInput("428-913").digits).toBe("428913");
    expect(readCodeInput("4 2 8 9 1 3").digits).toBe("428913");
    expect(readCodeInput("code: 428913").digits).toBe("428913");
  });

  it("stops at six digits so the field cannot overflow", () => {
    const state = readCodeInput("4289137777");
    expect(state.digits).toHaveLength(JOIN_CODE_LENGTH);
    expect(state.digits).toBe("428913");
    expect(state.complete).toBe(true);
  });

  it("treats a partial code as progress, not as an error", () => {
    for (const partial of ["", "4", "42891"]) {
      const state = readCodeInput(partial);
      expect(state.complete).toBe(false);
      expect(state.error).toBeNull();
    }
  });

  it("agrees with the contract's own validator on what six digits means", () => {
    // `normaliseJoinCode` delegates the shape decision to
    // `@partybooth/contracts/codes`, which is what Convex parses with. Letters never
    // survive the digit filter, so a full field is always a well-formed code.
    expect(readCodeInput("abcdef").digits).toBe("");
    expect(readCodeInput("000000").complete).toBe(true);
  });
});

describe("parseJoinResult", () => {
  it("passes a well-formed join straight through", () => {
    expect(
      parseJoinResult({
        outcome: "joined",
        eventId: "evt_1",
        membershipId: "mem_1",
        role: "guest",
        alreadyMember: false,
      }),
    ).toEqual({
      outcome: "joined",
      eventId: "evt_1",
      membershipId: "mem_1",
      role: "guest",
      alreadyMember: false,
    });
  });

  it("keeps a throttle intact, including how long to wait", () => {
    const result = parseJoinResult({
      outcome: "throttled",
      message: JOIN_THROTTLED_MESSAGE,
      retryAfterMs: 90_000,
    });
    expect(result).toEqual({
      outcome: "throttled",
      message: JOIN_THROTTLED_MESSAGE,
      retryAfterMs: 90_000,
    });
  });

  it("degrades a malformed payload to a rejection rather than trusting it", () => {
    // `src/lib/api.ts` asserts the wire shape with a hand-written cast; until Convex
    // codegen is real, this parse is the only thing actually checking it. Anything
    // unrecognised has to fail closed.
    for (const bad of [null, undefined, 42, {}, { outcome: "joined" }, { outcome: "nope" }]) {
      expect(parseJoinResult(bad)).toEqual({
        outcome: "rejected",
        message: JOIN_REJECTED_MESSAGE,
      });
    }
  });
});

describe("describeJoinFailure", () => {
  it("shows the contract's single rejection sentence, never a more specific one", () => {
    // The whole enumeration defence is that a dead code, a rotated token and a party
    // that has not opened are indistinguishable. If this test ever needs updating to
    // allow a second message, the defence is gone.
    const copy = describeJoinFailure({ outcome: "rejected", message: JOIN_REJECTED_MESSAGE });
    expect(copy.message).toBe(JOIN_REJECTED_MESSAGE);
    expect(copy.canRetry).toBe(true);
    expect(copy.retryAfterMs).toBeUndefined();
  });

  it("carries the wait through for a throttle, which is the caller's own history", () => {
    const copy = describeJoinFailure({
      outcome: "throttled",
      message: JOIN_THROTTLED_MESSAGE,
      retryAfterMs: 5 * 60_000,
    });
    expect(copy.retryAfterMs).toBe(5 * 60_000);
    expect(copy.canRetry).toBe(false);
    expect(copy.hint).toContain("5 minutes");
  });

  it("never claims the QR skips the lockout", () => {
    // The budget is charged per account, not per credential type, so a token join
    // is refused by the same lockout. Sending a throttled guest back to the sign to
    // be refused a second time is worse than telling them to wait.
    const copy = describeJoinFailure({
      outcome: "throttled",
      message: JOIN_THROTTLED_MESSAGE,
      retryAfterMs: 60_000,
    });
    expect(copy.hint).not.toMatch(/straight away|instead works|never gets throttled/i);
    expect(copy.hint).toMatch(/QR/);
    expect(copy.hint).toMatch(/wait/i);
  });
});

describe("formatRetryAfter", () => {
  it("always rounds up, so a retry at the stated time is not refused again", () => {
    expect(formatRetryAfter(61_000)).toBe("2 minutes");
    expect(formatRetryAfter(15 * 60_000)).toBe("15 minutes");
  });

  it("collapses anything under a minute", () => {
    expect(formatRetryAfter(1)).toBe("a minute");
    expect(formatRetryAfter(60_000)).toBe("a minute");
  });

  it("says something sensible for a missing or nonsense delay", () => {
    expect(formatRetryAfter(0)).toBe("a moment");
    expect(formatRetryAfter(-1)).toBe("a moment");
    expect(formatRetryAfter(Number.NaN)).toBe("a moment");
  });
});
