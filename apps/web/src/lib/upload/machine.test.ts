import { describe, expect, it } from "vitest";

import { CAPTURE_STATES, captureStateMachine, type CaptureState } from "@/lib/contracts";

import {
  capturedCaptureIds,
  emptyUploadQueue,
  findItem,
  isInFlight,
  isSettled,
  uploadReducer,
  type CapturedPayload,
  type UploadAction,
  type UploadQueue,
} from "./machine";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CAPTURE_ID = "w0123456789abcdef0123456789abcdef";

function capture(overrides: Partial<CapturedPayload> = {}): CapturedPayload {
  return {
    captureId: CAPTURE_ID,
    mediaType: "photo",
    mediaSource: "capture",
    // `File` exists in Node 26; the reducer never reads it, only carries it.
    file: new File([new Uint8Array(4)], "photo.jpg", { type: "image/jpeg" }),
    byteSize: 812_345,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    metadataStripped: true,
    width: 2560,
    height: 1920,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function run(actions: readonly UploadAction[], from: UploadQueue = emptyUploadQueue): UploadQueue {
  return actions.reduce(uploadReducer, from);
}

const CAPTURED: UploadAction = { type: "captured", capture: capture() };

function stateOf(queue: UploadQueue, captureId = CAPTURE_ID): CaptureState | undefined {
  return findItem(queue, captureId)?.state;
}

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe("uploadReducer — the happy path", () => {
  it("walks captured → queued → uploading → uploaded", () => {
    const queue = run([
      CAPTURED,
      { type: "queued", captureId: CAPTURE_ID },
      { type: "uploadStarted", captureId: CAPTURE_ID },
      { type: "progress", captureId: CAPTURE_ID, progress: 0.4 },
      { type: "uploaded", captureId: CAPTURE_ID, mediaState: "pending" },
    ]);

    const item = findItem(queue, CAPTURE_ID);
    expect(item?.state).toBe("uploaded");
    expect(item?.mediaState).toBe("pending");
    expect(item?.progress).toBe(1);
  });

  it("puts the newest capture first", () => {
    const queue = run([
      CAPTURED,
      { type: "captured", capture: capture({ captureId: "w".padEnd(33, "b") }) },
    ]);
    expect(queue.items[0]?.captureId).toBe("w".padEnd(33, "b"));
  });

  it("keeps the file and the checksum so a retry sends the same bytes", () => {
    // This is what makes retry safe: the grant is bound to `byteSize` and
    // `checksum`, so re-hashing a re-encoded file on retry would break it.
    const queue = run([CAPTURED, { type: "queued", captureId: CAPTURE_ID }]);
    expect(findItem(queue, CAPTURE_ID)?.checksum).toBe("a".repeat(64));
    expect(findItem(queue, CAPTURE_ID)?.byteSize).toBe(812_345);
  });

  it("keeps the accepted challenge assignment through retries", () => {
    const queue = run([
      { type: "captured", capture: capture({ challengeAssignmentId: "assignment_1" }) },
      { type: "queued", captureId: CAPTURE_ID },
      { type: "failed", captureId: CAPTURE_ID, message: "offline", retryable: true },
    ]);
    expect(findItem(queue, CAPTURE_ID)?.challengeAssignmentId).toBe("assignment_1");
  });
});

/* -------------------------------------------------------------------------- */
/* Illegal transitions                                                        */
/* -------------------------------------------------------------------------- */

describe("uploadReducer — illegal transitions are ignored, not thrown", () => {
  it("refuses to start an upload that was never queued", () => {
    const queue = run([CAPTURED, { type: "uploadStarted", captureId: CAPTURE_ID }]);
    expect(stateOf(queue)).toBe("captured");
  });

  it("refuses to move anything out of uploaded", () => {
    const settled = run([
      CAPTURED,
      { type: "queued", captureId: CAPTURE_ID },
      { type: "uploadStarted", captureId: CAPTURE_ID },
      { type: "uploaded", captureId: CAPTURE_ID },
    ]);

    for (const action of [
      { type: "failed", captureId: CAPTURE_ID, message: "no", retryable: true },
      { type: "queued", captureId: CAPTURE_ID },
      { type: "cancelled", captureId: CAPTURE_ID },
    ] satisfies UploadAction[]) {
      expect(stateOf(uploadReducer(settled, action))).toBe("uploaded");
    }
  });

  it("refuses to revive a cancelled capture", () => {
    const cancelled = run([CAPTURED, { type: "cancelled", captureId: CAPTURE_ID }]);
    expect(stateOf(uploadReducer(cancelled, { type: "queued", captureId: CAPTURE_ID }))).toBe(
      "cancelled",
    );
  });

  it("agrees with the contract's state machine on every pair", () => {
    // The reducer must not be a second opinion about the lifecycle: for each
    // legal move the reducer applies it, and for each illegal one it does not.
    const moves: Partial<Record<CaptureState, UploadAction>> = {
      queued: { type: "queued", captureId: CAPTURE_ID },
      uploading: { type: "uploadStarted", captureId: CAPTURE_ID },
      uploaded: { type: "uploaded", captureId: CAPTURE_ID },
      failed: { type: "failed", captureId: CAPTURE_ID, message: "x", retryable: true },
      cancelled: { type: "cancelled", captureId: CAPTURE_ID },
    };

    for (const from of CAPTURE_STATES) {
      const start = seedAt(from);
      if (start === undefined) continue;

      for (const [to, action] of Object.entries(moves) as [CaptureState, UploadAction][]) {
        if (from === to) continue;
        const next = stateOf(uploadReducer(start, action));
        expect(next === to).toBe(captureStateMachine.canTransition(from, to));
      }
    }
  });
});

/** Build a queue whose single item sits in `state`, or `undefined` if it cannot. */
function seedAt(state: CaptureState): UploadQueue | undefined {
  const paths: Record<CaptureState, UploadAction[]> = {
    captured: [],
    queued: [{ type: "queued", captureId: CAPTURE_ID }],
    uploading: [
      { type: "queued", captureId: CAPTURE_ID },
      { type: "uploadStarted", captureId: CAPTURE_ID },
    ],
    uploaded: [
      { type: "queued", captureId: CAPTURE_ID },
      { type: "uploadStarted", captureId: CAPTURE_ID },
      { type: "uploaded", captureId: CAPTURE_ID },
    ],
    failed: [
      { type: "queued", captureId: CAPTURE_ID },
      { type: "uploadStarted", captureId: CAPTURE_ID },
      { type: "failed", captureId: CAPTURE_ID, message: "x", retryable: true },
    ],
    cancelled: [{ type: "cancelled", captureId: CAPTURE_ID }],
  };

  const queue = run([CAPTURED, ...paths[state]]);
  return stateOf(queue) === state ? queue : undefined;
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

describe("uploadReducer — progress", () => {
  const uploading = run([
    CAPTURED,
    { type: "queued", captureId: CAPTURE_ID },
    { type: "uploadStarted", captureId: CAPTURE_ID },
  ]);

  it("never goes backwards", () => {
    const queue = run(
      [
        { type: "progress", captureId: CAPTURE_ID, progress: 0.8 },
        { type: "progress", captureId: CAPTURE_ID, progress: 0.3 },
      ],
      uploading,
    );
    expect(findItem(queue, CAPTURE_ID)?.progress).toBe(0.8);
  });

  it("clamps out-of-range and non-finite values", () => {
    expect(
      findItem(
        uploadReducer(uploading, { type: "progress", captureId: CAPTURE_ID, progress: 4 }),
        CAPTURE_ID,
      )?.progress,
    ).toBe(1);
    expect(
      findItem(
        uploadReducer(uploading, {
          type: "progress",
          captureId: CAPTURE_ID,
          progress: Number.NaN,
        }),
        CAPTURE_ID,
      )?.progress,
    ).toBe(0);
  });

  it("ignores a tick that arrives after a cancel", () => {
    // Normal on a phone: the abort resolves before the last XHR event lands.
    const cancelled = uploadReducer(uploading, { type: "cancelled", captureId: CAPTURE_ID });
    const after = uploadReducer(cancelled, {
      type: "progress",
      captureId: CAPTURE_ID,
      progress: 0.9,
    });
    expect(after).toBe(cancelled);
    expect(stateOf(after)).toBe("cancelled");
  });

  it("returns the identical object when nothing moved", () => {
    // React re-renders the whole queue otherwise, on every ignored tick.
    const unchanged = uploadReducer(uploading, {
      type: "progress",
      captureId: "not-in-the-queue",
      progress: 0.5,
    });
    expect(unchanged).toBe(uploading);
  });
});

/* -------------------------------------------------------------------------- */
/* Retry                                                                      */
/* -------------------------------------------------------------------------- */

describe("uploadReducer — failure and retry", () => {
  const failed = run([
    CAPTURED,
    { type: "queued", captureId: CAPTURE_ID },
    { type: "uploadStarted", captureId: CAPTURE_ID },
    { type: "progress", captureId: CAPTURE_ID, progress: 0.6 },
    { type: "failed", captureId: CAPTURE_ID, message: "You look offline.", retryable: true },
  ]);

  it("keeps the reason and whether trying again could work", () => {
    expect(findItem(failed, CAPTURE_ID)).toMatchObject({
      state: "failed",
      message: "You look offline.",
      retryable: true,
    });
  });

  it("re-queuing counts an attempt, resets progress and clears the message", () => {
    const retried = uploadReducer(failed, { type: "queued", captureId: CAPTURE_ID });
    expect(findItem(retried, CAPTURE_ID)).toMatchObject({
      state: "queued",
      attempts: 1,
      progress: 0,
      message: undefined,
    });
  });

  it("does not count the first send as an attempt", () => {
    const queued = uploadReducer(run([CAPTURED]), { type: "queued", captureId: CAPTURE_ID });
    expect(findItem(queued, CAPTURE_ID)?.attempts).toBe(0);
  });

  it("ignores a duplicate queue action, so a double tap cannot double-count", () => {
    const once = uploadReducer(failed, { type: "queued", captureId: CAPTURE_ID });
    const twice = uploadReducer(once, { type: "queued", captureId: CAPTURE_ID });
    expect(twice).toBe(once);
    expect(findItem(twice, CAPTURE_ID)?.attempts).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

describe("uploadReducer — housekeeping", () => {
  it("auto-starts only newly captured items, not failures awaiting a retry", () => {
    const secondId = "w".padEnd(33, "d");
    const queue = run([
      CAPTURED,
      { type: "queued", captureId: CAPTURE_ID },
      { type: "failed", captureId: CAPTURE_ID, message: "Try again.", retryable: true },
      { type: "captured", capture: capture({ captureId: secondId }) },
    ]);

    expect(capturedCaptureIds(queue)).toEqual([secondId]);
  });

  it("ignores a second capture of an id already in the queue", () => {
    // Swapping the file underneath an upload in flight is how a checksum stops
    // matching the grant it was minted against.
    const once = run([CAPTURED]);
    const twice = uploadReducer(once, {
      type: "captured",
      capture: capture({ byteSize: 999 }),
    });
    expect(twice).toBe(once);
    expect(findItem(twice, CAPTURE_ID)?.byteSize).toBe(812_345);
  });

  it("forgets one item, and every settled item", () => {
    const queue = run([
      CAPTURED,
      { type: "queued", captureId: CAPTURE_ID },
      { type: "uploadStarted", captureId: CAPTURE_ID },
      { type: "uploaded", captureId: CAPTURE_ID },
      { type: "captured", capture: capture({ captureId: "w".padEnd(33, "c") }) },
    ]);

    expect(uploadReducer(queue, { type: "forgetSettled" }).items).toHaveLength(1);
    expect(uploadReducer(queue, { type: "forget", captureId: CAPTURE_ID }).items).toHaveLength(1);
  });

  it("classifies states the same way the UI does", () => {
    expect(isSettled("uploaded")).toBe(true);
    expect(isSettled("cancelled")).toBe(true);
    expect(isSettled("failed")).toBe(false);
    expect(isInFlight("uploading")).toBe(true);
    expect(isInFlight("queued")).toBe(true);
    expect(isInFlight("captured")).toBe(false);
  });

  it("does nothing at all for an unknown capture id", () => {
    const queue = run([CAPTURED]);
    expect(uploadReducer(queue, { type: "queued", captureId: "nope" })).toBe(queue);
  });
});
