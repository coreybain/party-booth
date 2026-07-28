import { CAPTURE_UNDO_WINDOW_MS } from "@partybooth/contracts/media";
import { describe, expect, it } from "vitest";

import {
  countdownProgress,
  DEFAULT_UNDO_DELAY_MS,
  isCountdownElapsed,
  normaliseDelayMs,
  remainingMs,
  remainingSeconds,
  sendAtFor,
  UNDO_DELAY_MAX_MS,
} from "./countdown";

describe("normaliseDelayMs", () => {
  it("keeps a usable value untouched", () => {
    expect(normaliseDelayMs(7_000)).toBe(7_000);
  });

  it("clamps rather than rejecting, at both ends", () => {
    expect(normaliseDelayMs(-1)).toBe(0);
    expect(normaliseDelayMs(UNDO_DELAY_MAX_MS + 1_000)).toBe(UNDO_DELAY_MAX_MS);
  });

  it("falls back to the default for anything unusable", () => {
    // Every one of these is reachable: a hand-edited file, a value written by a
    // build that stored seconds, or a division that produced NaN.
    for (const bad of [undefined, null, "15000", NaN, Infinity, {}]) {
      expect(normaliseDelayMs(bad)).toBe(DEFAULT_UNDO_DELAY_MS);
    }
  });

  it("uses the contract's window as its default", () => {
    // PLAN.md promises 15 seconds; the number lives in @partybooth/contracts so
    // the app and the web capture page cannot drift apart on it.
    expect(DEFAULT_UNDO_DELAY_MS).toBe(CAPTURE_UNDO_WINDOW_MS);
  });
});

describe("the deadline", () => {
  it("is absolute, so a suspended app sends the moment it comes back", () => {
    const capturedAt = 1_000;
    const sendAt = sendAtFor(capturedAt, 15_000);
    expect(sendAt).toBe(16_000);
    // Two minutes in the background. A decrementing counter would still be
    // sitting at 14; the deadline is simply past.
    expect(isCountdownElapsed(sendAt, capturedAt + 120_000)).toBe(true);
    expect(remainingMs(sendAt, capturedAt + 120_000)).toBe(0);
  });

  it("never reports negative time left", () => {
    expect(remainingMs(1_000, 9_999)).toBe(0);
    expect(remainingSeconds(1_000, 9_999)).toBe(0);
  });
});

describe("remainingSeconds", () => {
  it("rounds up, so the window opens on its full number", () => {
    // The first render happens a few milliseconds after the shutter; showing 14
    // there would make a 15-second promise look like a lie.
    expect(remainingSeconds(15_000, 3)).toBe(15);
  });

  it("shows 1 for the whole of the final second", () => {
    expect(remainingSeconds(15_000, 14_001)).toBe(1);
    expect(remainingSeconds(15_000, 14_999)).toBe(1);
    expect(remainingSeconds(15_000, 15_000)).toBe(0);
  });
});

describe("countdownProgress", () => {
  it("runs 0 → 1 across the window", () => {
    const sendAt = sendAtFor(0, 10_000);
    expect(countdownProgress(sendAt, 10_000, 0)).toBe(0);
    expect(countdownProgress(sendAt, 10_000, 5_000)).toBeCloseTo(0.5);
    expect(countdownProgress(sendAt, 10_000, 10_000)).toBe(1);
  });

  it("is complete immediately when the delay is zero", () => {
    // "Send immediately" is a real setting; an empty ring for one frame is not.
    expect(countdownProgress(0, 0, 0)).toBe(1);
  });

  it("stays inside 0–1 either side of the window", () => {
    const sendAt = sendAtFor(1_000, 5_000);
    expect(countdownProgress(sendAt, 5_000, 0)).toBe(0);
    expect(countdownProgress(sendAt, 5_000, 99_999)).toBe(1);
  });
});
