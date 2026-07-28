/**
 * The hold-to-record gesture, exhaustively, in Node.
 *
 * This is where the timings are pinned down. The reducer takes `now` as an
 * argument and returns effects rather than performing them, so every case below
 * — including the ones that need a slow phone, a fast finger, or both at once —
 * is a function call rather than an evening with a stopwatch.
 *
 * The cases that matter are the overlaps: a release that lands *during* the
 * camera coming up, a 60-second cap that fires at the same moment as a finger
 * lifting, a second press while the previous clip is still being written. Each
 * of those is a real thing a guest does at a party and each of them is a
 * different way to end up with two recorders open or none.
 */

import { describe, expect, it } from "vitest";

import { VIDEO_MAX_DURATION_SECONDS } from "@partybooth/contracts/media";

import {
  formatClipDuration,
  HOLD_THRESHOLD_MS,
  IDLE_SHUTTER,
  isRecording,
  MAX_RECORDING_MS,
  needsVideoMode,
  recordedSeconds,
  recordingProgress,
  remainingRecordingSeconds,
  shutterReducer,
  shutterWakeUpAt,
  type ShutterEffect,
  type ShutterEvent,
  type ShutterState,
} from "./shutter";

const T0 = 1_000_000;

/** Run a sequence of events, collecting the effects each one produced. */
function run(events: readonly ShutterEvent[], from: ShutterState = IDLE_SHUTTER) {
  let state = from;
  const effects: ShutterEffect[] = [];
  for (const event of events) {
    const step = shutterReducer(state, event);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects, performed: effects.filter((effect) => effect !== "none") };
}

/* -------------------------------------------------------------------------- */
/* A tap                                                                      */
/* -------------------------------------------------------------------------- */

describe("shutter — a tap", () => {
  it("takes a photograph when the finger lifts before the threshold", () => {
    const { state, performed } = run([
      { type: "pressIn", now: T0 },
      { type: "release", now: T0 + HOLD_THRESHOLD_MS - 1 },
    ]);

    expect(performed).toEqual(["takePhoto"]);
    expect(state).toEqual(IDLE_SHUTTER);
  });

  it("takes a photograph even on an instant tap", () => {
    // A fast tap produces `pressIn` and `release` in the same millisecond, and
    // the ambiguous window has to survive being zero-length.
    const { performed } = run([
      { type: "pressIn", now: T0 },
      { type: "release", now: T0 },
    ]);
    expect(performed).toEqual(["takePhoto"]);
  });

  it("does not take a photograph when a hold is released", () => {
    const { performed } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 400 },
      { type: "release", now: T0 + 3_000 },
      { type: "recordingStopped", now: T0 + 3_100 },
    ]);
    // This is the defect `onPress` + `onLongPress` would have shipped: React
    // Native fires `onPress` on release *after* a long press on some platforms,
    // so a recording would have ended with a photograph as well.
    expect(performed).not.toContain("takePhoto");
  });
});

/* -------------------------------------------------------------------------- */
/* A hold                                                                     */
/* -------------------------------------------------------------------------- */

describe("shutter — a hold", () => {
  it("arms the recorder once the threshold is crossed, and not before", () => {
    const early = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS - 1 },
    ]);
    expect(early.performed).toEqual([]);
    expect(early.state.phase).toBe("pressed");

    const armed = run([{ type: "tick", now: T0 + HOLD_THRESHOLD_MS }], early.state);
    expect(armed.performed).toEqual(["armRecorder"]);
    expect(armed.state.phase).toBe("arming");
  });

  it("arms exactly once however many ticks arrive", () => {
    const { performed, state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + 300 },
      { type: "tick", now: T0 + 350 },
      { type: "tick", now: T0 + 400 },
    ]);
    // Two `armRecorder`s would flip the camera mode twice and rebuild the
    // capture session under a recorder that was already starting.
    expect(performed).toEqual(["armRecorder"]);
    expect(state.phase).toBe("arming");
  });

  it("starts the clock when the recorder starts, not when the finger landed", () => {
    // The camera took 800 ms to come up in video mode. The guest gets sixty
    // seconds of *recording*, and the ring has to agree with the file.
    const { state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 800 },
    ]);

    expect(state.phase).toBe("recording");
    expect(state.startedAt).toBe(T0 + 800);
    expect(recordingProgress(state, T0 + 800)).toBe(0);
    expect(recordedSeconds(state, T0 + 5_800)).toBe(5);
  });

  it("stops when the finger lifts", () => {
    const { performed, state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "release", now: T0 + 9_000 },
    ]);
    expect(performed).toEqual(["armRecorder", "stopRecording"]);
    expect(state.phase).toBe("stopping");
  });
});

/* -------------------------------------------------------------------------- */
/* The sixty-second cap                                                       */
/* -------------------------------------------------------------------------- */

describe("shutter — the hard stop", () => {
  it("uses the contract's limit, not a literal", () => {
    expect(MAX_RECORDING_MS).toBe(VIDEO_MAX_DURATION_SECONDS * 1_000);
  });

  it("stops itself at sixty seconds with the finger still down", () => {
    const held = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "tick", now: T0 + 300 + MAX_RECORDING_MS - 1 },
    ]);
    expect(held.performed).toEqual(["armRecorder"]);
    expect(held.state.phase).toBe("recording");

    const capped = run([{ type: "tick", now: T0 + 300 + MAX_RECORDING_MS }], held.state);
    expect(capped.performed).toEqual(["stopRecording"]);
    expect(capped.state.phase).toBe("stopping");
  });

  it("asks to stop only once, however late the ticks keep coming", () => {
    const { performed } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 },
      { type: "tick", now: T0 + MAX_RECORDING_MS },
      { type: "tick", now: T0 + MAX_RECORDING_MS + 50 },
      { type: "release", now: T0 + MAX_RECORDING_MS + 90 },
    ]);
    expect(performed.filter((effect) => effect === "stopRecording")).toHaveLength(1);
  });

  it("reports a full ring and no time left at the cap", () => {
    const { state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 },
    ]);

    expect(recordingProgress(state, T0 + MAX_RECORDING_MS)).toBe(1);
    // Past the cap it must stay 1 rather than growing — the ring is drawn from
    // this and a value over 1 lights every segment twice.
    expect(recordingProgress(state, T0 + MAX_RECORDING_MS * 2)).toBe(1);
    expect(remainingRecordingSeconds(state, T0 + MAX_RECORDING_MS)).toBe(0);
  });

  it("survives a clock that jumps backwards mid-clip", () => {
    // Not hypothetical: a phone that has just joined the party wifi gets an NTP
    // correction, and a negative elapsed time would draw a negative ring.
    const { state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 },
    ]);
    expect(recordingProgress(state, T0 - 5_000)).toBe(0);
    expect(recordedSeconds(state, T0 - 5_000)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The overlaps                                                               */
/* -------------------------------------------------------------------------- */

describe("shutter — releasing while the camera is still coming up", () => {
  it("stops the recording the instant it starts", () => {
    // The guest held for 300 ms on a phone that took 900 ms to switch to video
    // mode. Without `releasedEarly` this records until the sixty-second cap.
    const { performed, state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "release", now: T0 + 300 },
      { type: "recordingStarted", now: T0 + 900 },
    ]);

    expect(performed).toEqual(["armRecorder", "stopRecording"]);
    expect(state.phase).toBe("stopping");
  });

  it("does not take a photograph as well", () => {
    const { performed } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "release", now: T0 + 300 },
      { type: "recordingStarted", now: T0 + 900 },
      { type: "recordingStopped", now: T0 + 950 },
    ]);
    expect(performed).not.toContain("takePhoto");
  });

  it("returns to idle once the recorder confirms it stopped", () => {
    const { state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "release", now: T0 + 300 },
      { type: "recordingStarted", now: T0 + 900 },
      { type: "recordingStopped", now: T0 + 1_000 },
    ]);
    expect(state).toEqual(IDLE_SHUTTER);
  });
});

describe("shutter — presses that should do nothing", () => {
  it("ignores a press while a clip is still being written", () => {
    const stopping = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "release", now: T0 + 4_000 },
    ]).state;

    // A guest jabbing the button while the file finalises. Two `recordAsync`
    // calls on one capture session is two files and one of them orphaned.
    const again = run([{ type: "pressIn", now: T0 + 4_010 }], stopping);
    expect(again.performed).toEqual([]);
    expect(again.state.phase).toBe("stopping");
  });

  it("ignores a release nobody pressed for", () => {
    const { state, performed } = run([{ type: "release", now: T0 }]);
    expect(performed).toEqual([]);
    expect(state).toEqual(IDLE_SHUTTER);
  });

  it("ignores a second release during a stop", () => {
    const { performed } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "release", now: T0 + 4_000 },
      { type: "release", now: T0 + 4_020 },
    ]);
    expect(performed.filter((effect) => effect === "stopRecording")).toHaveLength(1);
  });

  it("ignores a tick that arrives when nothing is happening", () => {
    const { state, performed } = run([{ type: "tick", now: T0 }]);
    expect(performed).toEqual([]);
    expect(state).toEqual(IDLE_SHUTTER);
  });
});

/* -------------------------------------------------------------------------- */
/* Aborting                                                                   */
/* -------------------------------------------------------------------------- */

describe("shutter — abort", () => {
  it("stops a recording when the camera goes away", () => {
    const { performed, state } = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "abort", now: T0 + 2_000 },
    ]);
    expect(performed).toEqual(["armRecorder", "stopRecording"]);
    expect(state.phase).toBe("stopping");
  });

  it("resets a press that never became anything", () => {
    const { state, performed } = run([
      { type: "pressIn", now: T0 },
      { type: "abort", now: T0 + 50 },
    ]);
    expect(performed).toEqual([]);
    expect(state).toEqual(IDLE_SHUTTER);
  });

  it("leaves a stop that is already in flight alone", () => {
    // Resetting here would let the next press start a recording while the
    // previous file was still being written.
    const stopping = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "release", now: T0 + 4_000 },
    ]).state;

    const aborted = run([{ type: "abort", now: T0 + 4_100 }], stopping);
    expect(aborted.performed).toEqual([]);
    expect(aborted.state.phase).toBe("stopping");
  });
});

/* -------------------------------------------------------------------------- */
/* Reading the state                                                          */
/* -------------------------------------------------------------------------- */

describe("shutter — what the screen reads", () => {
  it("needs video mode from arming through to stopped", () => {
    let state = IDLE_SHUTTER;
    expect(needsVideoMode(state)).toBe(false);

    state = shutterReducer(state, { type: "pressIn", now: T0 }).state;
    // Still ambiguous: flipping the mode now would rebuild the capture session
    // on every tap and make the photo path slower than it was in Sprint 3.
    expect(needsVideoMode(state)).toBe(false);

    state = shutterReducer(state, { type: "tick", now: T0 + HOLD_THRESHOLD_MS }).state;
    expect(needsVideoMode(state)).toBe(true);

    state = shutterReducer(state, { type: "recordingStarted", now: T0 + 400 }).state;
    expect(needsVideoMode(state)).toBe(true);
    expect(isRecording(state)).toBe(true);

    state = shutterReducer(state, { type: "release", now: T0 + 4_000 }).state;
    // Still true while stopping — flipping back mid-finalise loses the file.
    expect(needsVideoMode(state)).toBe(true);
    expect(isRecording(state)).toBe(true);

    state = shutterReducer(state, { type: "recordingStopped", now: T0 + 4_100 }).state;
    expect(needsVideoMode(state)).toBe(false);
    expect(isRecording(state)).toBe(false);
  });

  it("wants no timer at all when nothing is happening", () => {
    // The state the shutter is in for all but a few seconds of an evening. A
    // 50 ms interval held open all night is a flat phone by the time the
    // slideshow starts.
    expect(shutterWakeUpAt(IDLE_SHUTTER, T0)).toBeNull();
  });

  it("wakes once at the hold threshold while a press is ambiguous", () => {
    const pressed = shutterReducer(IDLE_SHUTTER, { type: "pressIn", now: T0 }).state;
    expect(shutterWakeUpAt(pressed, T0)).toBe(T0 + HOLD_THRESHOLD_MS);
  });

  it("wakes on the tick interval while recording", () => {
    const recording = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
    ]).state;
    const wake = shutterWakeUpAt(recording, T0 + 1_000);
    expect(wake).not.toBeNull();
    expect(wake).toBeGreaterThan(T0 + 1_000);
  });

  it("wants no timer while a stop is in flight", () => {
    // The recorder's promise is what brings us back, not the clock.
    const stopping = run([
      { type: "pressIn", now: T0 },
      { type: "tick", now: T0 + HOLD_THRESHOLD_MS },
      { type: "recordingStarted", now: T0 + 300 },
      { type: "release", now: T0 + 4_000 },
    ]).state;
    expect(shutterWakeUpAt(stopping, T0 + 4_000)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

describe("formatClipDuration", () => {
  it("formats the numbers a badge actually shows", () => {
    expect(formatClipDuration(0)).toBe("0:00");
    expect(formatClipDuration(1)).toBe("0:01");
    expect(formatClipDuration(9.4)).toBe("0:09");
    expect(formatClipDuration(9.6)).toBe("0:10");
    expect(formatClipDuration(59)).toBe("0:59");
    // The one that is always wrong somewhere: the cap itself.
    expect(formatClipDuration(60)).toBe("1:00");
  });

  it("says 0:00 rather than NaN for a row with no duration", () => {
    // A pre-Sprint-4 row, or a video whose duration never reached the server.
    expect(formatClipDuration(undefined)).toBe("0:00");
    expect(formatClipDuration(Number.NaN)).toBe("0:00");
    expect(formatClipDuration(-1)).toBe("0:00");
  });
});
