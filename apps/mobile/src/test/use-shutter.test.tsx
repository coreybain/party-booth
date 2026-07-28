/**
 * The shutter, wired to a camera — the orchestration a screen test cannot reach.
 *
 * `react-native-web`'s `Pressable` routes `onPressIn`/`onPressOut` through its
 * responder system, which needs a real pointer pipeline and does not fire under
 * jsdom. That is why the wiring lives in a hook: here the presses are
 * `result.current.onPressIn()`, and the camera is a two-method object rather
 * than a native module.
 *
 * What this proves, which neither `shutter.test.ts` (pure, no camera) nor
 * `camera-screen.test.tsx` (renders, cannot press) can:
 *
 * - a tap reaches `onPhoto` and never touches the recorder;
 * - a hold flips `videoMode` **and waits for `onCameraReady`** before recording,
 *   which is the whole reason the `arming` phase exists;
 * - `recordAsync` is called once per hold, with both native caps;
 * - a release calls `stopRecording`, and the resolved clip reaches `onClip` with
 *   a measured duration;
 * - the torch is put out however the recording ended, failure included.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Mock } from "vitest";

import { VIDEO_MAX_BYTES, VIDEO_MAX_DURATION_SECONDS } from "@partybooth/contracts/media";

import { HOLD_THRESHOLD_MS } from "@/lib/shutter";
import { useShutter, type CameraRecorder, type RecordedClip } from "@/hooks/use-shutter";

vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));

/* -------------------------------------------------------------------------- */
/* A camera that is two functions                                             */
/* -------------------------------------------------------------------------- */

/**
 * A recorder whose promise settles when the test says so.
 *
 * The real `recordAsync` resolves when the recording *stops*, up to a minute
 * later — so a fake that resolved immediately would make every assertion about
 * "while recording" untestable. `settle()` is the stand-in for the OS closing
 * the file.
 */
function fakeRecorder() {
  const calls: unknown[] = [];
  let resolve: ((value: { uri: string } | undefined) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  const recorder: CameraRecorder & {
    calls: unknown[];
    settle: (value?: { uri: string } | undefined) => void;
    settleEmpty: () => void;
    fail: (error: Error) => void;
    stopped: number;
  } = {
    calls,
    stopped: 0,
    recordAsync: (options) => {
      calls.push(options);
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    stopRecording: () => {
      recorder.stopped += 1;
    },
    settle: (value = { uri: "file:///cache/clip.mov" }) => resolve?.(value),
    // A separate method rather than `settle(undefined)`: a JS default parameter
    // fires for an explicit `undefined` too, so that call would have quietly
    // resolved with a clip and the assertion below would have tested nothing.
    settleEmpty: () => resolve?.(undefined),
    fail: (error) => reject?.(error),
  };
  return recorder;
}

/**
 * The four callbacks, typed as the hook declares them.
 *
 * `ReturnType<typeof vi.fn>` would be the untyped `Mock`, which does not satisfy
 * `UseShutterInput` — and more usefully, typing them properly means a change to
 * `RecordedClip` breaks this file rather than silently letting the assertions
 * inspect a shape that no longer exists.
 */
interface Harness {
  onPhoto: Mock<() => void>;
  onClip: Mock<(clip: RecordedClip) => void>;
  onError: Mock<(message: string) => void>;
  onRecordingEnd: Mock<() => void>;
}

function newSpies(): Harness {
  return {
    onPhoto: vi.fn<() => void>(),
    onClip: vi.fn<(clip: RecordedClip) => void>(),
    onError: vi.fn<(message: string) => void>(),
    onRecordingEnd: vi.fn<() => void>(),
  };
}

function setup(overrides: { videoEnabled?: boolean; disabled?: boolean } = {}) {
  const recorder = fakeRecorder();
  const camera = { current: recorder as CameraRecorder | null };
  const spies = newSpies();

  const hook = renderHook(() =>
    useShutter({
      camera,
      onPhoto: spies.onPhoto,
      onClip: spies.onClip,
      onError: spies.onError,
      onRecordingEnd: spies.onRecordingEnd,
      videoEnabled: overrides.videoEnabled ?? true,
      disabled: overrides.disabled ?? false,
    }),
  );

  return { ...hook, recorder, camera, spies };
}

/** Hold past the threshold and let the camera come up in video mode. */
async function holdUntilRecording(harness: ReturnType<typeof setup>) {
  act(() => harness.result.current.onPressIn());
  // The threshold tick is driven by a real timer inside the hook.
  await waitFor(() => {
    expect(harness.result.current.videoMode).toBe(true);
  });
  // The mode flip cleared `ready`; the rebuilt session reports itself up.
  act(() => harness.result.current.onCameraReady());
  await waitFor(() => {
    expect(harness.recorder.calls).toHaveLength(1);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Tap                                                                        */
/* -------------------------------------------------------------------------- */

describe("useShutter — a tap", () => {
  it("takes a photograph and never starts the recorder", async () => {
    const harness = setup();

    act(() => harness.result.current.onPressIn());
    act(() => harness.result.current.onPressOut());

    await waitFor(() => {
      expect(harness.spies.onPhoto).toHaveBeenCalledTimes(1);
    });
    expect(harness.recorder.calls).toHaveLength(0);
    expect(harness.result.current.videoMode).toBe(false);
    expect(harness.result.current.recording).toBe(false);
  });

  it("takes one photograph per press, not one per render", async () => {
    const harness = setup();

    act(() => harness.result.current.onPressIn());
    act(() => harness.result.current.onPressOut());
    act(() => harness.result.current.onPressIn());
    act(() => harness.result.current.onPressOut());

    await waitFor(() => {
      expect(harness.spies.onPhoto).toHaveBeenCalledTimes(2);
    });
  });

  it("does nothing at all while disabled", async () => {
    // A paused party, or a tab that is not on screen.
    const harness = setup({ disabled: true });

    act(() => harness.result.current.onPressIn());
    act(() => harness.result.current.onPressOut());

    await new Promise((resolve) => setTimeout(resolve, HOLD_THRESHOLD_MS + 50));
    expect(harness.spies.onPhoto).not.toHaveBeenCalled();
    expect(harness.recorder.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Hold                                                                       */
/* -------------------------------------------------------------------------- */

describe("useShutter — a hold", () => {
  it("waits for the camera to come up in video mode before recording", async () => {
    const harness = setup();

    act(() => harness.result.current.onPressIn());
    await waitFor(() => {
      expect(harness.result.current.videoMode).toBe(true);
    });

    // This is the assertion the whole `arming` phase exists for. `recordAsync`
    // in `mode="picture"` is refused by expo-camera, and the mode change tears
    // down and rebuilds the capture session — so nothing may be recorded until
    // `onCameraReady` fires again.
    expect(harness.recorder.calls).toHaveLength(0);
    expect(harness.result.current.recording).toBe(false);

    act(() => harness.result.current.onCameraReady());
    await waitFor(() => {
      expect(harness.recorder.calls).toHaveLength(1);
    });
    expect(harness.result.current.recording).toBe(true);
  });

  it("passes both native caps to the recorder", async () => {
    const harness = setup();
    await holdUntilRecording(harness);

    // Drawn in the UI *and* enforced by the OS. A JS timer on a backgrounded
    // phone is not something to stake a 250 MB upload on.
    expect(harness.recorder.calls[0]).toEqual({
      maxDuration: VIDEO_MAX_DURATION_SECONDS,
      maxFileSize: VIDEO_MAX_BYTES,
    });
  });

  it("records once per hold however often the camera reports itself ready", async () => {
    const harness = setup();
    await holdUntilRecording(harness);

    // A session can settle noisily. A second `recordAsync` on one capture
    // session is two files, one of them orphaned.
    act(() => harness.result.current.onCameraReady());
    act(() => harness.result.current.onCameraReady());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.recorder.calls).toHaveLength(1);
  });

  it("stops the recorder when the finger lifts and reports the clip", async () => {
    const harness = setup();
    await holdUntilRecording(harness);

    act(() => harness.result.current.onPressOut());
    expect(harness.recorder.stopped).toBe(1);

    await act(async () => {
      harness.recorder.settle({ uri: "file:///cache/clip.mov" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.spies.onClip).toHaveBeenCalledTimes(1);
    });
    const clip = harness.spies.onClip.mock.calls[0]?.[0];
    expect(clip).toBeDefined();
    if (clip === undefined) return;
    expect(clip.uri).toBe("file:///cache/clip.mov");
    // Measured wall-clock, so a real clip is never reported as zero-length.
    expect(clip.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(clip.durationSeconds).toBeLessThanOrEqual(VIDEO_MAX_DURATION_SECONDS);
    expect(clip.startedAt).toBeGreaterThan(0);
  });

  it("returns to picture mode and idles once the clip is written", async () => {
    const harness = setup();
    await holdUntilRecording(harness);

    act(() => harness.result.current.onPressOut());
    await act(async () => {
      harness.recorder.settle();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.result.current.recording).toBe(false);
    });
    expect(harness.result.current.videoMode).toBe(false);
  });

  it("reports nothing when the recorder was stopped before it wrote anything", async () => {
    const harness = setup();
    await holdUntilRecording(harness);

    act(() => harness.result.current.onPressOut());
    await act(async () => {
      // `undefined` is what `recordAsync` resolves to when it never started.
      harness.recorder.settleEmpty();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.result.current.recording).toBe(false);
    });
    expect(harness.spies.onClip).not.toHaveBeenCalled();
    // Still an ending, so the torch still goes out.
    expect(harness.spies.onRecordingEnd).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Releasing early                                                            */
/* -------------------------------------------------------------------------- */

describe("useShutter — released while the camera was still coming up", () => {
  it("stops the recording the instant it starts", async () => {
    const harness = setup();

    act(() => harness.result.current.onPressIn());
    await waitFor(() => {
      expect(harness.result.current.videoMode).toBe(true);
    });

    // The finger lifts while the session is still being rebuilt. Without this
    // being remembered, the clip runs to the sixty-second cap.
    act(() => harness.result.current.onPressOut());
    expect(harness.recorder.calls).toHaveLength(0);

    act(() => harness.result.current.onCameraReady());
    await waitFor(() => {
      expect(harness.recorder.calls).toHaveLength(1);
    });
    // Started, and immediately told to stop.
    await waitFor(() => {
      expect(harness.recorder.stopped).toBe(1);
    });
    expect(harness.spies.onPhoto).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

describe("useShutter — when the recorder fails", () => {
  it("says one sentence, ends the recording, and puts the torch out", async () => {
    const harness = setup();
    await holdUntilRecording(harness);

    await act(async () => {
      harness.recorder.fail(new Error("camera was taken by another app"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.spies.onError).toHaveBeenCalledTimes(1);
    });
    expect(harness.spies.onClip).not.toHaveBeenCalled();
    // The failure path is exactly where a `finally` in the screen would have
    // been forgotten, and a torch left burning is the fastest way to flatten a
    // phone at a party.
    expect(harness.spies.onRecordingEnd).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(harness.result.current.recording).toBe(false);
    });
  });

  it("recovers when there is no camera behind the ref at all", async () => {
    const harness = setup();
    harness.camera.current = null;

    act(() => harness.result.current.onPressIn());
    await waitFor(() => {
      expect(harness.result.current.videoMode).toBe(true);
    });
    act(() => harness.result.current.onCameraReady());

    // Aborted rather than wedged: the next press has to work.
    await waitFor(() => {
      expect(harness.result.current.videoMode).toBe(false);
    });
    expect(harness.result.current.recording).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* No microphone                                                              */
/* -------------------------------------------------------------------------- */

describe("useShutter — without the microphone", () => {
  it("treats a long hold as a tap rather than offering a gesture that fails", async () => {
    // `recordAudioAndroid` is on, so a recording without the permission fails
    // outright. A guest who holds the button gets a photograph, which is a
    // better answer than an error about a permission they never chose.
    const harness = setup({ videoEnabled: false });

    act(() => harness.result.current.onPressIn());
    await new Promise((resolve) => setTimeout(resolve, HOLD_THRESHOLD_MS + 80));

    expect(harness.result.current.videoMode).toBe(false);
    expect(harness.recorder.calls).toHaveLength(0);

    act(() => harness.result.current.onPressOut());
    await waitFor(() => {
      expect(harness.spies.onPhoto).toHaveBeenCalledTimes(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Losing the camera mid-recording                                            */
/* -------------------------------------------------------------------------- */

describe("useShutter — when the camera goes away mid-clip", () => {
  it("stops the recorder, because no release event is coming", async () => {
    const recorder = fakeRecorder();
    const camera = { current: recorder as CameraRecorder | null };
    const spies = newSpies();

    const hook = renderHook(
      ({ disabled }: { disabled: boolean }) =>
        useShutter({
          camera,
          onPhoto: spies.onPhoto,
          onClip: spies.onClip,
          onError: spies.onError,
          onRecordingEnd: spies.onRecordingEnd,
          disabled,
        }),
      { initialProps: { disabled: false } },
    );

    act(() => hook.result.current.onPressIn());
    await waitFor(() => {
      expect(hook.result.current.videoMode).toBe(true);
    });
    act(() => hook.result.current.onCameraReady());
    await waitFor(() => {
      expect(recorder.calls).toHaveLength(1);
    });

    // The tab lost focus, or the host paused the party. Neither produces a
    // finger lifting.
    hook.rerender({ disabled: true });

    await waitFor(() => {
      expect(recorder.stopped).toBe(1);
    });
  });
});
