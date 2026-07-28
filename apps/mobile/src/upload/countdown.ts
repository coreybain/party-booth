/**
 * The undo window.
 *
 * PLAN.md promises "auto-send with 15-s undo", and Sprint 3 makes the length a
 * setting (0–60 s, per media type on/off). All of that is arithmetic on two
 * numbers — when the shutter fired and how long the guest asked for — so it
 * lives here as pure functions rather than inside a component with a `setState`
 * in an interval, where it would be untestable and would drift the moment the
 * app is backgrounded.
 *
 * The two properties that matter:
 *
 * 1. **The deadline is absolute, not a decrementing counter.** A countdown that
 *    ticks down 15 times stops when the JS timer stops — which is exactly what a
 *    locked screen does. Storing `sendAt` means a phone that comes back after
 *    two minutes sends immediately, which is the correct behaviour and also the
 *    only one that survives a restart.
 * 2. **Zero is a real setting, not "off".** `undoDelayMs: 0` means send now; the
 *    guest can still cancel while it is queued or uploading. "Off" is the
 *    per-type auto-send toggle, which is a different question.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import { CAPTURE_UNDO_WINDOW_MS } from "@partybooth/contracts/media";

/** The product default, straight from the contract. */
export const DEFAULT_UNDO_DELAY_MS = CAPTURE_UNDO_WINDOW_MS;

export const UNDO_DELAY_MIN_MS = 0;
/** PLAN's ceiling. Longer than a minute is a drafts folder, not an undo. */
export const UNDO_DELAY_MAX_MS = 60_000;
/** The granularity the slider moves in. */
export const UNDO_DELAY_STEP_MS = 5_000;

/**
 * Clamp anything to a usable delay.
 *
 * Total, and never throws: this parses a value off disk that a previous build
 * (or a hand-edited file) may have written, and a bad number must degrade to the
 * default rather than to a capture that never sends.
 */
export function normaliseDelayMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_UNDO_DELAY_MS;
  const rounded = Math.round(value);
  if (rounded < UNDO_DELAY_MIN_MS) return UNDO_DELAY_MIN_MS;
  if (rounded > UNDO_DELAY_MAX_MS) return UNDO_DELAY_MAX_MS;
  return rounded;
}

/** When a capture taken at `capturedAt` stops being undoable. */
export function sendAtFor(capturedAt: number, delayMs: number): number {
  return capturedAt + normaliseDelayMs(delayMs);
}

/** Milliseconds left, floored at zero. */
export function remainingMs(sendAt: number, now: number): number {
  return Math.max(0, sendAt - now);
}

/**
 * Whole seconds left, as shown on the button.
 *
 * Rounded **up**, so a 15-second window reads "15" for its first tick rather
 * than flashing "14" the instant it appears, and reads "1" for the whole of the
 * final second rather than showing a "0" nobody can act on.
 */
export function remainingSeconds(sendAt: number, now: number): number {
  return Math.ceil(remainingMs(sendAt, now) / 1000);
}

export function isCountdownElapsed(sendAt: number, now: number): boolean {
  return now >= sendAt;
}

/**
 * How far through the window we are, 0 → 1, for the progress ring.
 *
 * A zero-length window is already complete; returning `0` there would draw an
 * empty ring for one frame on every capture with the delay turned down.
 */
export function countdownProgress(sendAt: number, delayMs: number, now: number): number {
  const total = normaliseDelayMs(delayMs);
  if (total <= 0) return 1;
  const elapsed = total - remainingMs(sendAt, now);
  if (elapsed <= 0) return 0;
  if (elapsed >= total) return 1;
  return elapsed / total;
}

/**
 * How often the countdown UI should re-render.
 *
 * Four times a second: fast enough that the ring looks continuous, slow enough
 * that a phone with ten queued captures is not re-rendering a list at 60 Hz for
 * a number that changes once a second.
 */
export const COUNTDOWN_TICK_MS = 250;
