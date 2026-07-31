/**
 * The shutter, wired to a camera.
 *
 * `src/lib/shutter.ts` decides *what* a press means, with no React and no Expo,
 * and is unit-tested in Node. This hook is the other half: it holds the machine,
 * performs the four effects the machine asks for, and hands the screen back the
 * handful of values a viewfinder actually draws.
 *
 * ## Why this is a hook and not part of the screen
 *
 * Two reasons, and the second is the one that matters.
 *
 * 1. The screen is already five permission states, a fallback and a control bar.
 *    Recording adds a ref, four effects and a promise held open for a minute.
 * 2. **It is the only way this is testable.** `react-native-web`'s `Pressable`
 *    routes `onPressIn`/`onPressOut` through its responder system, which needs a
 *    real pointer pipeline and does not fire under jsdom — so a screen test can
 *    render the button and can never press it. Behind a hook, the same
 *    behaviour is `result.current.onPressIn()`: a real test of the real
 *    orchestration, with a two-method fake where the camera goes. The
 *    physical-device pass in Sprint 6 is still what proves the picture is sharp;
 *    this is what proves the button does the right thing at all.
 *
 * The camera is taken as a **structural** interface rather than as `CameraView`,
 * so nothing here imports `expo-camera` and a test needs no native module.
 */

import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";

import { VIDEO_MAX_BYTES, VIDEO_MAX_DURATION_SECONDS } from "@partybooth/contracts/media";

import { captureHandledError } from "../lib/sentry";
import {
  IDLE_SHUTTER,
  isRecording as isShutterRecording,
  needsVideoMode,
  recordedSeconds,
  recordingProgress,
  remainingRecordingSeconds,
  shutterReducer,
  shutterWakeUpAt,
  type ShutterEffect,
  type ShutterEvent,
  type ShutterState,
} from "../lib/shutter";

/* -------------------------------------------------------------------------- */
/* The camera, as little of it as this needs                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two methods recording uses.
 *
 * Structural rather than `CameraView`, because that is the whole of the
 * dependency and naming the class would drag a native module into every test
 * that touches the shutter. `expo-camera`'s `CameraView` satisfies this.
 */
export interface CameraRecorder {
  recordAsync(options?: {
    maxDuration?: number;
    maxFileSize?: number;
  }): Promise<{ uri: string } | undefined>;
  stopRecording(): void;
}

/** What a finished recording hands back. */
export interface RecordedClip {
  readonly uri: string;
  /**
   * Wall-clock between the recorder starting and its promise settling.
   *
   * Measured rather than probed from the container: `recordAsync` reports only a
   * URI, reading the duration back costs a decode, and this is the number the
   * guest watched count up on the ring. `validateMediaFile` requires one.
   */
  readonly durationSeconds: number;
  readonly startedAt: number;
}

/* -------------------------------------------------------------------------- */
/* The machine, adapted to useReducer                                          */
/* -------------------------------------------------------------------------- */

/**
 * `shutterReducer` returns `{ state, effect }`; `useReducer` wants one value.
 *
 * `seq` is what makes "perform this effect once" exact. Two presses in a row
 * produce the same state and the same effect, and React may render a state more
 * than once — so the effect hook compares the sequence number rather than the
 * effect, and a photograph is taken once per press rather than once per render.
 */
interface ShutterMachine {
  readonly state: ShutterState;
  readonly seq: number;
  readonly effect: ShutterEffect;
}

const INITIAL: ShutterMachine = { state: IDLE_SHUTTER, seq: 0, effect: "none" };

function machineReducer(machine: ShutterMachine, event: ShutterEvent): ShutterMachine {
  const step = shutterReducer(machine.state, event);
  if (step.state === machine.state && step.effect === "none") return machine;
  return { state: step.state, seq: machine.seq + 1, effect: step.effect };
}

/* -------------------------------------------------------------------------- */
/* The hook                                                                   */
/* -------------------------------------------------------------------------- */

export interface UseShutterInput {
  /** Populated by the screen's `ref` on `CameraView`. */
  readonly camera: { current: CameraRecorder | null };
  /** A tap. The screen takes the picture; the machine only says when. */
  readonly onPhoto: () => void;
  /** A finished clip, ready for the pipeline. */
  readonly onClip: (clip: RecordedClip) => void;
  /** One sentence for the guest when the recorder itself failed. */
  readonly onError: (message: string) => void;
  /**
   * Every recording ends here, however it ended.
   *
   * Exists so the screen can put the torch out. It has to fire on the error path
   * too, which is exactly the case a `finally` in the screen would miss.
   */
  readonly onRecordingEnd?: (() => void) | undefined;
  /**
   * Stop whatever is happening and refuse to start anything new.
   *
   * The tab losing focus, the party pausing mid-hold, the preview erroring —
   * none of them produce a release event, so the screen has to say so.
   */
  readonly disabled?: boolean | undefined;
  /**
   * Whether a hold can become a recording at all.
   *
   * `false` when the microphone has not been granted — `recordAudioAndroid` is
   * on, so a recording without it fails outright rather than producing a silent
   * clip. Rather than offering a gesture that cannot work, the hold threshold is
   * simply never crossed: the press stays ambiguous and the release takes a
   * photograph. A guest who holds the button gets a picture, which is a better
   * answer than an error about a permission they did not know they needed.
   */
  readonly videoEnabled?: boolean | undefined;
}

export interface ShutterController {
  readonly state: ShutterState;
  /** The recorder is running (or being stopped). Drives the ring and the label. */
  readonly recording: boolean;
  /** `CameraView` has to be in `mode="video"` right now. */
  readonly videoMode: boolean;
  /** 0–1 of the sixty-second cap. */
  readonly progress: number;
  readonly seconds: number;
  readonly remaining: number;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  /**
   * Hand straight to `CameraView`'s `onCameraReady`.
   *
   * It fires on mount **and on every `mode` change**, which is precisely what
   * arming needs: the mode flips to video, the session is rebuilt, this fires,
   * and only then does `recordAsync` get called. No guessed delay anywhere.
   */
  readonly onCameraReady: () => void;
  /** True once the camera has reported itself ready in its current mode. */
  readonly ready: boolean;
}

const RECORDER_FAILED = "The camera couldn't record that one. Try again.";

export function useShutter(input: UseShutterInput): ShutterController {
  const {
    camera,
    onPhoto,
    onClip,
    onError,
    onRecordingEnd,
    disabled = false,
    videoEnabled = true,
  } = input;

  const [machine, dispatch] = useReducer(machineReducer, INITIAL);
  /**
   * How many times the camera has reported itself ready — **not** a boolean.
   *
   * `onCameraReady` fires on mount and again after every `mode` change, and
   * arming needs to distinguish "the session that was already up" from "the
   * rebuilt video session". A boolean forces an effect to clear it, which is a
   * synchronous `setState` inside an effect and a cascading render; a counter
   * lets arming simply remember which tick it armed at and wait for a later one.
   */
  const [readyTick, setReadyTick] = useState(0);
  const readyTickRef = useRef(0);
  /**
   * The clock, as state rather than a `Date.now()` read during render.
   *
   * The ring, the seconds and the "left" count are all derived from this, and
   * reading the wall clock while rendering makes those values change when React
   * happens to re-render rather than when time passes — which is both a purity
   * violation and, under a re-render storm, a ring that jumps.
   */
  const [tickedAt, setTickedAt] = useState(0);
  const handledSeq = useRef(0);
  /** Set by `armRecorder`, cleared by the recording that answers it. */
  const pendingArm = useRef(false);
  /** Which `readyTick` we armed at; recording waits for a strictly later one. */
  const armedAtTick = useRef(0);

  /*
   * Mirrors of the callbacks, written after commit.
   *
   * The recording promise is held across up to sixty seconds of renders, so
   * closing over the render-time callbacks would call whichever ones existed
   * when the finger landed. Assigned in an effect rather than during render:
   * under React 19 a render can be started, thrown away and started again, and a
   * ref written during a discarded render would leave this holding a callback
   * that was never committed.
   */
  const callbacks = useRef({ onPhoto, onClip, onError, onRecordingEnd });
  useEffect(() => {
    callbacks.current = { onPhoto, onClip, onError, onRecordingEnd };
  }, [onPhoto, onClip, onError, onRecordingEnd]);

  /* ---------------------------------------------------------------- */
  /* Recording                                                        */
  /* ---------------------------------------------------------------- */

  /*
   * This is an Effect Event rather than a memoized render callback. Recording
   * starts only from the arming effect, and it must read whichever recorder the
   * ref contains at that moment. Putting a mutable `camera.current` behind
   * `useCallback([camera])` describes the wrong dependency to the React
   * Compiler: the ref object is stable while its current value is deliberately
   * not. Effect Events are built for exactly this "latest value, effect-only"
   * boundary.
   */
  const beginRecording = useEffectEvent(() => {
    void (async () => {
      const recorder = camera.current;
      if (recorder === null) {
        dispatch({ type: "abort", now: Date.now() });
        return;
      }

      const startedAt = Date.now();
      // Before the await, not after: `recordAsync` resolves when the recording
      // *stops*, so awaiting first would start the ring a minute late.
      dispatch({ type: "recordingStarted", now: startedAt });

      try {
        // Both caps go to the OS as well as being drawn in the UI. The machine
        // will call `stopRecording()` at sixty seconds, but a JS timer on a
        // backgrounded phone is not something to stake a 250 MB upload on.
        const clip = await recorder.recordAsync({
          maxDuration: VIDEO_MAX_DURATION_SECONDS,
          maxFileSize: VIDEO_MAX_BYTES,
        });
        const stoppedAt = Date.now();
        dispatch({ type: "recordingStopped", now: stoppedAt });

        // `undefined` means it was stopped before anything was written.
        if (clip === undefined) return;

        callbacks.current.onClip({
          uri: clip.uri,
          durationSeconds: Math.min(VIDEO_MAX_DURATION_SECONDS, (stoppedAt - startedAt) / 1_000),
          startedAt,
        });
      } catch (error) {
        captureHandledError(error, { scope: "camera.recordAsync" });
        dispatch({ type: "recordingStopped", now: Date.now() });
        callbacks.current.onError(RECORDER_FAILED);
      } finally {
        callbacks.current.onRecordingEnd?.();
      }
    })();
  });

  /* ---------------------------------------------------------------- */
  /* Effects the machine asked for                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (machine.seq === handledSeq.current) return;
    handledSeq.current = machine.seq;

    switch (machine.effect) {
      case "takePhoto":
        callbacks.current.onPhoto();
        return;
      case "armRecorder":
        // Nothing to call yet. `videoMode` is already true, so the screen has
        // flipped `mode`; remembering the current tick is what makes the *next*
        // `onCameraReady` mean "the rebuilt video session is up" rather than the
        // stale one left over from picture mode.
        pendingArm.current = true;
        armedAtTick.current = readyTickRef.current;
        return;
      case "stopRecording":
        try {
          camera.current?.stopRecording();
        } catch (error) {
          // A recorder that will not stop must not leave the machine wedged in
          // `stopping`, where no future press can start anything.
          captureHandledError(error, { scope: "camera.stopRecording" });
          dispatch({ type: "recordingStopped", now: Date.now() });
        }
        return;
      default:
        return;
    }
  }, [machine.seq, machine.effect, camera]);

  /**
   * Armed, and the camera has come up in video mode. Go.
   *
   * A separate effect because the two conditions arrive in either order: on a
   * fast phone `onCameraReady` fires before the hold threshold, on a slow one
   * long after. `pendingArm` makes it fire exactly once per arm — `ready` can
   * flip more than once while the session settles, and a second `recordAsync`
   * on one capture session is two files and one of them orphaned.
   */
  useEffect(() => {
    if (machine.state.phase !== "arming") return;
    if (!pendingArm.current) return;
    // Strictly later than the tick we armed at: the ready we are waiting for is
    // the *rebuilt* session's, not the picture-mode one that was already up.
    if (readyTick <= armedAtTick.current) return;
    pendingArm.current = false;
    beginRecording();
  }, [machine.state.phase, readyTick]);

  /**
   * The clock, running only when there is something to time.
   *
   * `shutterWakeUpAt` is `null` in `idle`, which is the state the shutter is in
   * for all but a few seconds of an evening — so the common case is no timer at
   * all rather than a 50 ms interval held open all night.
   */
  useEffect(() => {
    // Without video, a press never matures into a hold — see `videoEnabled`.
    if (!videoEnabled && machine.state.phase === "pressed") return;
    const now = Date.now();
    const wakeAt = shutterWakeUpAt(machine.state, now);
    if (wakeAt === null) return;
    const timer = setTimeout(
      () => {
        const at = Date.now();
        dispatch({ type: "tick", now: at });
        setTickedAt(at);
      },
      Math.max(16, wakeAt - now),
    );
    return () => clearTimeout(timer);
  }, [machine.state, tickedAt, videoEnabled]);

  /** The camera went away. Stop the recorder and reset. */
  useEffect(() => {
    if (!disabled) return;
    dispatch({ type: "abort", now: Date.now() });
  }, [disabled]);

  /* ---------------------------------------------------------------- */
  /* Handlers                                                         */
  /* ---------------------------------------------------------------- */

  const onPressIn = useCallback(() => {
    if (disabled) return;
    dispatch({ type: "pressIn", now: Date.now() });
  }, [disabled]);

  // Deliberately **not** gated on `disabled`: a party that pauses while a finger
  // is down still has to see the finger lift, or the machine stays pressed for
  // ever and the next tap does nothing.
  const onPressOut = useCallback(() => {
    dispatch({ type: "release", now: Date.now() });
  }, []);

  const onCameraReady = useCallback(() => {
    // The ref is what the arming effect reads synchronously; the state is what
    // brings the component back to notice.
    readyTickRef.current += 1;
    setReadyTick(readyTickRef.current);
  }, []);

  // Derived from state, never from a wall-clock read during render.
  const now = tickedAt;
  return {
    state: machine.state,
    recording: isShutterRecording(machine.state),
    videoMode: needsVideoMode(machine.state),
    progress: recordingProgress(machine.state, now),
    seconds: recordedSeconds(machine.state, now),
    remaining: remainingRecordingSeconds(machine.state, now),
    onPressIn,
    onPressOut,
    onCameraReady,
    ready: readyTick > 0,
  };
}
