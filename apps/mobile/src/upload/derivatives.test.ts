/**
 * Derivatives in the durable queue — scheduling, persistence and the sweep.
 *
 * The Sprint 3 carry-over landed as a **second grant under the same
 * `captureId`** (ADR 0008), which means the queue now runs two kinds of work
 * against one row. The invariants that keeps are the ones tested here, and each
 * of them has a way of failing that is silent at a party:
 *
 * 1. **A derivative never runs before its original has landed.** The backend
 *    refuses `derivativeWithoutOriginal`, and although that refusal is
 *    deliberately retryable, racing it burns a round trip of party wifi to be
 *    told to wait.
 * 2. **Originals always beat derivatives.** Every photograph still waiting to
 *    reach the host goes before any thumbnail does.
 * 3. **A derivative's failure is not the capture's failure.** The photograph is
 *    in the party; a missing preview costs a fellow guest a larger image and
 *    nothing else.
 * 4. **A row is never forgotten while it still owes a file**, because the row is
 *    the only thing that names the file.
 *
 * Plain Node — no React, no Expo.
 */

import { describe, expect, it } from "vitest";

import { nextTask, hasPendingWork } from "./queue-engine";
import { parseQueue, serialiseQueue } from "./persistence";
import {
  derivativesSettled,
  forgettableItems,
  localFilesOf,
  MAX_DERIVATIVE_ATTEMPTS,
  nextDerivative,
  queueItemFromDraft,
  queueReducer,
} from "./queue-reducer";
import { EMPTY_QUEUE, type CaptureDraft, type QueueDerivative, type QueueItem } from "./types";

const NOW = Date.UTC(2026, 7, 5, 21, 0, 0);

function aDerivative(overrides: Partial<QueueDerivative> = {}): QueueDerivative {
  return {
    role: "preview",
    state: "pending",
    uri: "file:///captures/m_1-share-preview.jpg",
    byteSize: 320_000,
    mimeType: "image/jpeg",
    checksum: "b".repeat(64),
    width: 1280,
    height: 960,
    attempts: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

function anItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    captureId: "m_1",
    eventId: "event_1",
    state: "uploaded",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///captures/m_1-original.jpg",
    previewUri: "file:///captures/m_1-preview.jpg",
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    capturedAt: NOW,
    sourceMetadataStripped: true,
    derivatives: [aDerivative()],
    autoSend: true,
    sendAt: NOW,
    undoDelayMs: 15_000,
    attempts: 1,
    nextAttemptAt: NOW,
    progress: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

function stateWith(items: readonly QueueItem[]) {
  return { hydrated: true, items };
}

/* -------------------------------------------------------------------------- */
/* Admission                                                                  */
/* -------------------------------------------------------------------------- */

describe("derivatives — admission", () => {
  it("schedules what the pipeline produced, and owns the scheduling fields", () => {
    const draft: CaptureDraft = {
      captureId: "m_9",
      eventId: "event_1",
      mediaType: "video",
      mediaSource: "capture",
      uri: "file:///captures/m_9-original.mov",
      previewUri: "file:///captures/m_9-share-poster.jpg",
      byteSize: 40_000_000,
      mimeType: "video/quicktime",
      checksum: "c".repeat(64),
      durationSeconds: 12,
      capturedAt: NOW,
      sourceMetadataStripped: true,
      derivatives: [
        {
          role: "poster",
          uri: "file:///captures/m_9-share-poster.jpg",
          byteSize: 240_000,
          mimeType: "image/jpeg",
          checksum: "d".repeat(64),
        },
      ],
    };

    const item = queueItemFromDraft(draft, { autoSend: true, undoDelayMs: 15_000 }, NOW);

    expect(item.derivatives).toHaveLength(1);
    // The pipeline made the file; the queue decides when it goes. A caller that
    // could supply `attempts` is a caller that can admit a row already spent.
    expect(item.derivatives[0]).toMatchObject({
      role: "poster",
      state: "pending",
      attempts: 0,
      nextAttemptAt: 0,
    });
  });

  it("admits a capture with no derivatives at all", () => {
    // A video whose poster could not be made. It must be sendable — a missing
    // derivative never strands a capture.
    const draft: CaptureDraft = {
      captureId: "m_10",
      eventId: "event_1",
      mediaType: "video",
      mediaSource: "capture",
      uri: "file:///captures/m_10-original.mp4",
      previewUri: "file:///captures/m_10-original.mp4",
      byteSize: 10_000_000,
      mimeType: "video/mp4",
      checksum: "e".repeat(64),
      durationSeconds: 4,
      capturedAt: NOW,
      sourceMetadataStripped: true,
    };

    const item = queueItemFromDraft(draft, { autoSend: true, undoDelayMs: 0 }, NOW);
    expect(item.derivatives).toEqual([]);
    expect(derivativesSettled(item)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* -------------------------------------------------------------------------- */

describe("derivatives — what runs next", () => {
  it("does not offer a derivative until its original has landed", () => {
    const queued = anItem({ state: "queued", nextAttemptAt: NOW - 1 });
    expect(nextDerivative(queued, NOW)).toBeUndefined();

    // The backend would refuse this with `derivativeWithoutOriginal`. Racing a
    // refusal we can predict is a wasted round trip on party wifi.
    const task = nextTask([queued], NOW);
    expect(task).toMatchObject({ kind: "original" });
  });

  it("offers the derivative once the original is uploaded", () => {
    const item = anItem();
    expect(nextDerivative(item, NOW)).toMatchObject({ role: "preview" });
    expect(nextTask([item], NOW)).toMatchObject({ kind: "derivative" });
  });

  it("puts every waiting photograph before any thumbnail", () => {
    // The thumbnail is four minutes older than the photograph. It still loses:
    // an original that has not arrived costs the host the picture, and a
    // derivative that has not arrived costs a fellow guest a larger image.
    const oldWithDerivative = anItem({ captureId: "m_old", capturedAt: NOW - 240_000 });
    const newOriginal = anItem({
      captureId: "m_new",
      state: "queued",
      capturedAt: NOW,
      nextAttemptAt: NOW - 1,
      derivatives: [],
    });

    const task = nextTask([oldWithDerivative, newOriginal], NOW);
    expect(task).toMatchObject({ kind: "original" });
    expect(task?.item.captureId).toBe("m_new");
  });

  it("runs derivatives oldest first once no original is waiting", () => {
    const older = anItem({ captureId: "m_a", capturedAt: NOW - 60_000 });
    const newer = anItem({ captureId: "m_b", capturedAt: NOW });

    const task = nextTask([newer, older], NOW);
    expect(task?.item.captureId).toBe("m_a");
  });

  it("respects a derivative's own backoff", () => {
    const backing = anItem({
      derivatives: [aDerivative({ attempts: 1, nextAttemptAt: NOW + 5_000 })],
    });
    expect(nextDerivative(backing, NOW)).toBeUndefined();
    expect(nextDerivative(backing, NOW + 5_000)).toMatchObject({ role: "preview" });
  });

  it("keeps the engine awake for a derivative nothing else would wake it for", () => {
    // The last photograph of the evening. Without this the preview would sit
    // until some *other* capture happened, which at the end of a party is never.
    const item = anItem();
    expect(hasPendingWork([item])).toBe(true);

    const settled = anItem({ derivatives: [aDerivative({ state: "uploaded" })] });
    expect(hasPendingWork([settled])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The reducer                                                                */
/* -------------------------------------------------------------------------- */

describe("derivatives — state transitions", () => {
  it("counts an attempt when one starts", () => {
    const next = queueReducer(stateWith([anItem()]), {
      type: "derivativeStarted",
      captureId: "m_1",
      role: "preview",
      now: NOW,
    });
    expect(next.items[0]?.derivatives[0]).toMatchObject({ state: "uploading", attempts: 1 });
  });

  it("marks it uploaded, and says so idempotently", () => {
    const started = queueReducer(stateWith([anItem()]), {
      type: "derivativeStarted",
      captureId: "m_1",
      role: "preview",
      now: NOW,
    });
    const done = queueReducer(started, {
      type: "derivativeSucceeded",
      captureId: "m_1",
      role: "preview",
      now: NOW + 1_000,
    });
    expect(done.items[0]?.derivatives[0]?.state).toBe("uploaded");

    // The provider retries its callback; a repeat has to change nothing.
    const again = queueReducer(done, {
      type: "derivativeSucceeded",
      captureId: "m_1",
      role: "preview",
      now: NOW + 2_000,
    });
    expect(again).toBe(done);
  });

  it("backs a retryable failure off rather than giving up", () => {
    const started = queueReducer(stateWith([anItem()]), {
      type: "derivativeStarted",
      captureId: "m_1",
      role: "preview",
      now: NOW,
    });
    const failed = queueReducer(started, {
      type: "derivativeFailed",
      captureId: "m_1",
      role: "preview",
      permanent: false,
      now: NOW + 500,
    });

    const derivative = failed.items[0]?.derivatives[0];
    expect(derivative?.state).toBe("pending");
    expect(derivative?.nextAttemptAt).toBeGreaterThan(NOW + 500);
  });

  it("honours a retry-after from the server over the backoff table", () => {
    const started = queueReducer(stateWith([anItem()]), {
      type: "derivativeStarted",
      captureId: "m_1",
      role: "preview",
      now: NOW,
    });
    const failed = queueReducer(started, {
      type: "derivativeFailed",
      captureId: "m_1",
      role: "preview",
      permanent: false,
      retryAfterMs: 30_000,
      now: NOW,
    });
    expect(failed.items[0]?.derivatives[0]?.nextAttemptAt).toBe(NOW + 30_000);
  });

  it("abandons a refusal a retry cannot fix", () => {
    // `duplicateDerivative` and `derivativeMetadataNotStripped` are permanent in
    // the contract. Retrying either on a timer is battery spent on a certainty.
    const started = queueReducer(stateWith([anItem()]), {
      type: "derivativeStarted",
      captureId: "m_1",
      role: "preview",
      now: NOW,
    });
    const failed = queueReducer(started, {
      type: "derivativeFailed",
      captureId: "m_1",
      role: "preview",
      permanent: true,
      now: NOW,
    });
    expect(failed.items[0]?.derivatives[0]?.state).toBe("abandoned");
  });

  it("gives up after a small number of attempts", () => {
    let state = stateWith([anItem()]);
    for (let attempt = 0; attempt < MAX_DERIVATIVE_ATTEMPTS; attempt += 1) {
      state = queueReducer(state, {
        type: "derivativeStarted",
        captureId: "m_1",
        role: "preview",
        now: NOW,
      });
      state = queueReducer(state, {
        type: "derivativeFailed",
        captureId: "m_1",
        role: "preview",
        permanent: false,
        now: NOW,
      });
      // Each round has to leave it runnable again, or the loop is not testing
      // the ladder.
      if (attempt < MAX_DERIVATIVE_ATTEMPTS - 1) {
        state = {
          ...state,
          items: state.items.map((item) => ({
            ...item,
            derivatives: item.derivatives.map((d) => ({ ...d, nextAttemptAt: 0 })),
          })),
        };
      }
    }
    expect(state.items[0]?.derivatives[0]?.state).toBe("abandoned");
    expect(derivativesSettled(state.items[0]!)).toBe(true);
  });

  it("never touches the capture's own state", () => {
    // A derivative attaches a key and stops: no state change, no counter, no
    // completion row. One capture is one submission however many objects it
    // arrives as.
    const before = anItem();
    const after = queueReducer(stateWith([before]), {
      type: "derivativeFailed",
      captureId: "m_1",
      role: "preview",
      permanent: true,
      now: NOW,
    });
    expect(after.items[0]?.state).toBe("uploaded");
    expect(after.items[0]?.progress).toBe(1);
    expect(after.items[0]?.failure).toBeUndefined();
  });

  it("ignores an event for a role this capture does not have", () => {
    const state = stateWith([anItem()]);
    const next = queueReducer(state, {
      type: "derivativeSucceeded",
      captureId: "m_1",
      role: "poster",
      now: NOW,
    });
    expect(next).toBe(state);
  });
});

/* -------------------------------------------------------------------------- */
/* Resume                                                                     */
/* -------------------------------------------------------------------------- */

describe("derivatives — surviving a restart", () => {
  it("puts an in-flight derivative back to pending on hydration", () => {
    // A request cannot outlive its process. A row still claiming `uploading` on
    // a cold start is a row that needs attempting again.
    const stuck = anItem({ derivatives: [aDerivative({ state: "uploading", attempts: 1 })] });
    const next = queueReducer(EMPTY_QUEUE, {
      type: "hydrate",
      items: [stuck],
      now: NOW,
    });
    expect(next.items[0]?.derivatives[0]?.state).toBe("pending");
    // The attempt still counts — it really was made.
    expect(next.items[0]?.derivatives[0]?.attempts).toBe(1);
  });

  it("does the same when the app comes back to the foreground", () => {
    // iOS suspends a backgrounded app mid-socket; what comes back is a promise
    // that will never settle.
    const stuck = anItem({ derivatives: [aDerivative({ state: "uploading" })] });
    const next = queueReducer(stateWith([stuck]), { type: "resume", now: NOW });
    expect(next.items[0]?.derivatives[0]?.state).toBe("pending");
  });

  it("leaves a settled queue untouched on resume", () => {
    const state = stateWith([anItem({ derivatives: [aDerivative({ state: "uploaded" })] })]);
    // Same reference, so React can bail out of the re-render. `resume` fires on
    // every foreground, which for a phone in a pocket is often.
    expect(queueReducer(state, { type: "resume", now: NOW })).toBe(state);
  });

  it("round-trips through the persisted file", () => {
    const item = anItem({
      derivatives: [aDerivative({ attempts: 2, nextAttemptAt: NOW + 5_000 })],
    });
    const [restored] = parseQueue(serialiseQueue([item]));

    expect(restored?.derivatives).toHaveLength(1);
    expect(restored?.derivatives[0]).toMatchObject({
      role: "preview",
      state: "pending",
      byteSize: 320_000,
      checksum: "b".repeat(64),
      attempts: 2,
      nextAttemptAt: NOW + 5_000,
    });
  });

  it("reads a row written before derivatives existed", () => {
    // The whole point of `derivatives` being absent-tolerant: a Sprint 3 row is
    // a capture that genuinely has no derivative and never will.
    const legacy = JSON.stringify({
      version: 1,
      items: [{ ...anItem(), derivatives: undefined }],
    });
    const [restored] = parseQueue(legacy);
    expect(restored?.derivatives).toEqual([]);
  });

  it("drops one unreadable derivative without losing the others", () => {
    const item = anItem({ derivatives: [aDerivative(), aDerivative({ role: "poster" })] });
    const raw = JSON.parse(serialiseQueue([item])) as {
      items: { derivatives: Record<string, unknown>[] }[];
    };
    // A field a future build spelled differently.
    delete raw.items[0]!.derivatives[0]!.checksum;

    const [restored] = parseQueue(JSON.stringify(raw));
    expect(restored?.derivatives).toHaveLength(1);
    expect(restored?.derivatives[0]?.role).toBe("poster");
  });

  it("drops a second derivative claiming the same role", () => {
    // One capture has one object per role; a second is the shape the server
    // answers with `duplicateDerivative`.
    const raw = JSON.stringify({
      version: 1,
      items: [{ ...anItem(), derivatives: [aDerivative(), aDerivative({ byteSize: 999 })] }],
    });
    const [restored] = parseQueue(raw);
    expect(restored?.derivatives).toHaveLength(1);
    expect(restored?.derivatives[0]?.byteSize).toBe(320_000);
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* -------------------------------------------------------------------------- */

describe("derivatives — the file sweep", () => {
  const policy = { uploadedKeepMs: 5 * 60_000, cancelledKeepMs: 5_000 };
  const later = NOW + 10 * 60_000;

  it("keeps a row that still owes a derivative, however old it is", () => {
    // The row is the only thing that names the file. Forgetting it here deletes
    // a preview that was never sent, and no later sweep could recognise it.
    const owing = anItem({ updatedAt: NOW });
    expect(forgettableItems([owing], later, policy)).toEqual([]);
  });

  it("forgets it once every derivative has an answer", () => {
    const done = anItem({
      updatedAt: NOW,
      derivatives: [aDerivative({ state: "uploaded" })],
    });
    expect(forgettableItems([done], later, policy)).toHaveLength(1);

    const givenUp = anItem({
      updatedAt: NOW,
      derivatives: [aDerivative({ state: "abandoned" })],
    });
    // Abandoned counts as an answer: the file is dead weight and should go.
    expect(forgettableItems([givenUp], later, policy)).toHaveLength(1);
  });

  it("still forgets a cancelled capture promptly", () => {
    // An undone capture's derivatives die with it — they are never attempted —
    // so a pending one must not keep a full-resolution photo on disk.
    const cancelled = anItem({ state: "cancelled", updatedAt: NOW });
    expect(forgettableItems([cancelled], NOW + 6_000, policy)).toHaveLength(1);
  });

  it("names every file the capture owns, without duplicates", () => {
    const video = anItem({
      uri: "file:///captures/m_1-original.mov",
      // A video's poster doubles as its local thumbnail.
      previewUri: "file:///captures/m_1-share-poster.jpg",
      derivatives: [aDerivative({ role: "poster", uri: "file:///captures/m_1-share-poster.jpg" })],
    });

    expect(localFilesOf(video)).toEqual([
      "file:///captures/m_1-original.mov",
      "file:///captures/m_1-share-poster.jpg",
    ]);
  });

  it("copes with a capture whose poster could not be made", () => {
    // `previewUri` falls back to the video itself, so the two are equal.
    const noPoster = anItem({
      uri: "file:///captures/m_2-original.mp4",
      previewUri: "file:///captures/m_2-original.mp4",
      derivatives: [],
    });
    expect(localFilesOf(noPoster)).toEqual(["file:///captures/m_2-original.mp4"]);
  });
});
