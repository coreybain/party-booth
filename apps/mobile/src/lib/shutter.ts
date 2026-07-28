/**
 * The shutter, as a state machine.
 *
 * One button does two things — tap for a photograph, hold for a video — and the
 * whole difference between "this feels like a camera" and "this feels broken" is
 * in the timings and in what happens when they overlap. So the timings live here,
 * as a pure reducer over `(state, event, now)`, and the camera screen owns only
 * the promises.
 *
 * ## The five moments
 *
 * ```
 *   idle ──pressIn──▶ pressed ──tick(≥250ms)──▶ arming ──recordingStarted──▶ recording
 *            │                     │                          │
 *            │                release: PHOTO             release / tick(60s): stopRecording
 *            │                     │                          │
 *            ◀─────────────────────┘                          ▼
 *            ◀──────────────────── stopping ◀─────────── recordingStopped ──▶ idle
 * ```
 *
 * - **`pressed`** is the ambiguity. Nothing has been decided; a release here is a
 *   photograph. 250 ms is the threshold because it is roughly the shortest hold a
 *   person performs *deliberately* — below it you get videos from people trying
 *   to take a picture, above it (the RN default `delayLongPress` is 500 ms) the
 *   button feels like it is thinking.
 *
 * - **`arming`** is the bit that has to exist and would not occur to you until a
 *   real device refuses to record. `expo-camera` records only with
 *   `mode="video"`, and changing `mode` tears down and rebuilds the capture
 *   session — so the screen flips the mode on entering `arming` and waits for
 *   `onCameraReady` before calling `recordAsync`. Modelling the wait as a state
 *   rather than a `setTimeout` is what makes it honest: the ring starts when the
 *   recorder *actually* started, not 250 ms after a finger landed, so the 60 s
 *   the guest watches is the 60 s they get.
 *
 * - **`recording`** ends three ways and they must all converge: the finger lifts,
 *   the 60 s cap is reached, or the recorder stops on its own (the OS took the
 *   camera, the disk filled, `maxDuration` fired natively). All of them route
 *   through `stopping`, so `stopRecording()` is called at most once and the
 *   promise from `recordAsync` is awaited exactly once.
 *
 * - **`stopping`** exists so a second release, a late tick, or a guest jabbing
 *   the button while the file is still being written cannot start a new
 *   recording on top of the one being finalised.
 *
 * ## Rules
 *
 * 1. **Nothing here knows the time.** `now` is an argument, always.
 * 2. **Every event is legal in every state.** A camera button is pressed by
 *    somebody holding a drink; an unexpected release must be a no-op, never a
 *    throw and never a stuck recording.
 * 3. **Effects are returned, not performed.** The reducer says "take a photo" /
 *    "start recording" / "stop recording"; the screen does it. That is what lets
 *    the whole gesture be tested in plain Node with no camera in the room.
 *
 * No React and no Expo imports — unit-tested in `src/lib`, in Node.
 */

import { VIDEO_MAX_DURATION_SECONDS } from "@partybooth/contracts/media";

/* -------------------------------------------------------------------------- */
/* Timings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How long a press has to last before it means "video".
 *
 * Deliberately shorter than React Native's 500 ms `delayLongPress` default: this
 * is not a long-press menu, it is the difference between two modes of the same
 * control, and half a second of nothing happening reads as a dead button.
 */
export const HOLD_THRESHOLD_MS = 250;

/**
 * The hard stop, from the contract rather than from a literal here.
 *
 * `MEDIA_LIMITS.video.maxDurationSeconds` is what `validateMediaFile` refuses a
 * grant over, so a UI that allowed 61 seconds would let a guest record something
 * the server was always going to reject. The native `maxDuration` passed to
 * `recordAsync` is the authority; this is what draws the ring and what stops the
 * recorder if the two ever disagree.
 */
export const MAX_RECORDING_MS = VIDEO_MAX_DURATION_SECONDS * 1_000;

/** How often the ring wants redrawing while recording. ~20 fps of a 60 s sweep. */
export const RECORDING_TICK_MS = 50;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type ShutterPhase =
  /** Nothing is happening. */
  | "idle"
  /** A finger is down and it is not yet clear what it means. */
  | "pressed"
  /** It means video. Waiting for the camera to come up in video mode. */
  | "arming"
  /** Bytes are being written. */
  | "recording"
  /** `stopRecording()` has been called; the file is being finalised. */
  | "stopping";

export interface ShutterState {
  readonly phase: ShutterPhase;
  /** When the finger landed. `null` outside a press. */
  readonly pressedAt: number | null;
  /** When the **recorder** started — not when the finger landed. `null` before. */
  readonly startedAt: number | null;
  /**
   * True once the finger has lifted but the recorder has not stopped yet.
   *
   * Kept rather than collapsed into the phase because "released during `arming`"
   * has to be remembered: the camera may not have come up yet, and the recording
   * that is about to start must stop the instant it does. Without this, a quick
   * hold-and-release on a slow device records until the 60 s cap.
   */
  readonly releasedEarly: boolean;
}

export const IDLE_SHUTTER: ShutterState = {
  phase: "idle",
  pressedAt: null,
  startedAt: null,
  releasedEarly: false,
};

/* -------------------------------------------------------------------------- */
/* Events and effects                                                         */
/* -------------------------------------------------------------------------- */

export type ShutterEvent =
  | { readonly type: "pressIn"; readonly now: number }
  | { readonly type: "release"; readonly now: number }
  /** The clock moved. Crosses the hold threshold and the 60 s cap. */
  | { readonly type: "tick"; readonly now: number }
  /** `recordAsync` has been called and the camera reported itself ready. */
  | { readonly type: "recordingStarted"; readonly now: number }
  /** The recorder's promise settled, however it settled. */
  | { readonly type: "recordingStopped"; readonly now: number }
  /**
   * Give up wherever we are: the tab lost focus, the camera errored, the party
   * stopped accepting uploads mid-hold.
   */
  | { readonly type: "abort"; readonly now: number };

export type ShutterEffect =
  | "none"
  /** Tap. `takePictureAsync`. */
  | "takePhoto"
  /**
   * The hold threshold has passed: put the camera into video mode.
   *
   * There is deliberately **no `startRecording` effect**. Arming is not a thing
   * that finishes on this side — it finishes when the *camera* says the rebuilt
   * video session is up, which is a fact the machine cannot know and must not
   * guess at. So `armRecorder` is the last word the machine has on the subject,
   * and `recordingStarted` is the caller telling it what happened.
   */
  | "armRecorder"
  /** `stopRecording`. Emitted exactly once per recording. */
  | "stopRecording";

export interface ShutterStep {
  readonly state: ShutterState;
  readonly effect: ShutterEffect;
}

function step(state: ShutterState, effect: ShutterEffect = "none"): ShutterStep {
  return { state, effect };
}

/* -------------------------------------------------------------------------- */
/* The reducer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Advance the shutter by one event.
 *
 * Returns the next state **and** the one thing the screen should do about it.
 * Never throws: every combination of event and phase has an answer, and the
 * answer for the ones that cannot happen is "nothing changed".
 */
export function shutterReducer(state: ShutterState, event: ShutterEvent): ShutterStep {
  switch (event.type) {
    case "pressIn": {
      // A press arriving while a previous recording is still being written is
      // the double-jab case. Ignoring it is what stops two `recordAsync` calls
      // overlapping on one capture session.
      if (state.phase !== "idle") return step(state);
      return step({
        phase: "pressed",
        pressedAt: event.now,
        startedAt: null,
        releasedEarly: false,
      });
    }

    case "release": {
      switch (state.phase) {
        case "pressed":
          // Under the threshold, so it was a tap all along.
          return step(IDLE_SHUTTER, "takePhoto");
        case "arming":
          // The finger is gone but the recorder may already be starting. Remember
          // it; `recordingStarted` stops it the moment it exists.
          return step({ ...state, releasedEarly: true });
        case "recording":
          return step({ ...state, phase: "stopping" }, "stopRecording");
        default:
          return step(state);
      }
    }

    case "tick": {
      if (state.phase === "pressed" && state.pressedAt !== null) {
        if (event.now - state.pressedAt < HOLD_THRESHOLD_MS) return step(state);
        return step({ ...state, phase: "arming" }, "armRecorder");
      }

      if (state.phase === "recording" && state.startedAt !== null) {
        if (event.now - state.startedAt < MAX_RECORDING_MS) return step(state);
        // The hard stop. `recordAsync({ maxDuration })` will also fire natively;
        // whichever lands first, `stopping` makes the second one a no-op.
        return step({ ...state, phase: "stopping" }, "stopRecording");
      }

      return step(state);
    }

    case "recordingStarted": {
      if (state.phase !== "arming") return step(state);
      const recording: ShutterState = { ...state, phase: "recording", startedAt: event.now };
      // Held for less time than the camera took to come up. The clip would be
      // zero-length and nobody wants it, so it is stopped immediately — and it
      // still has to *be* stopped rather than abandoned, because the recorder is
      // running and holds the file.
      if (state.releasedEarly) return step({ ...recording, phase: "stopping" }, "stopRecording");
      return step(recording);
    }

    case "recordingStopped":
      return step(IDLE_SHUTTER);

    case "abort": {
      if (state.phase === "recording") {
        return step({ ...state, phase: "stopping" }, "stopRecording");
      }
      // `stopping` is left alone: the stop is already in flight and the promise
      // is what returns us to idle. Resetting here would let a fresh press start
      // a recording while the old file is still being written.
      if (state.phase === "stopping") return step(state);
      return step(IDLE_SHUTTER);
    }

    default: {
      const never: never = event;
      void never;
      return step(state);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the state                                                          */
/* -------------------------------------------------------------------------- */

/** Whether the camera has to be in `mode="video"` right now. */
export function needsVideoMode(state: ShutterState): boolean {
  return state.phase === "arming" || state.phase === "recording" || state.phase === "stopping";
}

/** Whether a recording is underway, for the ring and the red dot. */
export function isRecording(state: ShutterState): boolean {
  return state.phase === "recording" || state.phase === "stopping";
}

/**
 * How far through the 60 s the recording is, 0–1.
 *
 * Clamped at both ends: a clock that jumps backwards (an NTP correction mid-clip
 * is not hypothetical on a phone that has just joined a wifi network) must not
 * draw a negative ring, and the value must reach exactly 1 rather than 0.997 so
 * the ring closes.
 */
export function recordingProgress(state: ShutterState, now: number): number {
  if (state.startedAt === null) return 0;
  const elapsed = now - state.startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(1, elapsed / MAX_RECORDING_MS);
}

/** Seconds recorded so far, rounded down — the number next to the ring. */
export function recordedSeconds(state: ShutterState, now: number): number {
  if (state.startedAt === null) return 0;
  const elapsed = now - state.startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(VIDEO_MAX_DURATION_SECONDS, Math.floor(elapsed / 1_000));
}

/** Seconds left, for "12s left" once the clip is getting long. */
export function remainingRecordingSeconds(state: ShutterState, now: number): number {
  return Math.max(0, VIDEO_MAX_DURATION_SECONDS - recordedSeconds(state, now));
}

/**
 * When the machine next needs waking, or `null` when it can go quiet.
 *
 * The camera screen runs no timer at all in `idle`, which is the state it is in
 * for all but a few seconds of a party. During a press it needs one wake-up (the
 * threshold); during a recording it needs the tick that draws the ring.
 */
export function shutterWakeUpAt(state: ShutterState, now: number): number | null {
  if (state.phase === "pressed" && state.pressedAt !== null) {
    return state.pressedAt + HOLD_THRESHOLD_MS;
  }
  if (state.phase === "recording") return now + RECORDING_TICK_MS;
  return null;
}

/**
 * "0:07" / "1:00" — the clip length, wherever one is shown.
 *
 * Re-exported under this module's own name because the recording overlay, the
 * gallery badge and the "My media" row all show it and they must agree — and
 * they must now also agree with the web console, which had a byte-for-byte
 * identical `formatDuration` of its own. A duration formatter is exactly the
 * sort of thing that is wrong for zero and for sixty and is never noticed until
 * it is on a TV, which is an argument for having one of them rather than two.
 */
export { formatDuration as formatClipDuration } from "@partybooth/contracts/copy";
