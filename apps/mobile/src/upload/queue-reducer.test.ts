import { describe, expect, it } from "vitest";

import { DEFAULT_UNDO_DELAY_MS } from "./countdown";
import {
  backoffMsFor,
  forgettableItems,
  itemsForEvent,
  MAX_AUTO_ATTEMPTS,
  pendingCountForEvent,
  queueItemFromDraft,
  queueReducer,
  RETRY_BACKOFF_MS,
  undoableItem,
} from "./queue-reducer";
import { EMPTY_QUEUE, type CaptureDraft, type QueueItem, type QueueState } from "./types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const T0 = 1_700_000_000_000;

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    captureId: "capture0001",
    eventId: "event1",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///captures/capture0001-original.jpg",
    previewUri: "file:///captures/capture0001-preview.jpg",
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    width: 3000,
    height: 4000,
    capturedAt: T0,
    sourceMetadataStripped: true,
    ...overrides,
  };
}

function itemFrom(
  overrides: Partial<CaptureDraft> = {},
  autoSend = true,
  delayMs = DEFAULT_UNDO_DELAY_MS,
): QueueItem {
  return queueItemFromDraft(draft(overrides), { autoSend, undoDelayMs: delayMs }, T0);
}

function queueOf(...items: QueueItem[]): QueueState {
  return { hydrated: true, items };
}

/** Apply a list of actions in order — most tests are about a sequence. */
function run(state: QueueState, ...actions: Parameters<typeof queueReducer>[1][]): QueueState {
  return actions.reduce(queueReducer, state);
}

/* -------------------------------------------------------------------------- */

describe("queueItemFromDraft", () => {
  it("starts in `captured` and schedules its own send", () => {
    const item = itemFrom();
    expect(item.state).toBe("captured");
    expect(item.sendAt).toBe(T0 + DEFAULT_UNDO_DELAY_MS);
    expect(item.attempts).toBe(0);
    expect(item.progress).toBe(0);
  });

  it("still goes through `captured` with a zero-length window", () => {
    // Skipping the state would give the Photos tab two shapes to handle for what
    // is one setting.
    const item = itemFrom({}, true, 0);
    expect(item.state).toBe("captured");
    expect(item.sendAt).toBe(T0);
  });

  it("records the auto-send decision on the row, not just in settings", () => {
    // Settings can change between the capture and the send; the row must not.
    expect(itemFrom({}, false).autoSend).toBe(false);
  });

  it("stamps the authenticated owner onto a new capture", () => {
    const item = queueItemFromDraft(
      draft(),
      { autoSend: true, undoDelayMs: DEFAULT_UNDO_DELAY_MS },
      T0,
      "user_a",
    );
    expect(item.ownerUserId).toBe("user_a");
  });
});

describe("the undo window", () => {
  it("closes on a tick and moves the capture to `queued`", () => {
    const item = itemFrom();
    const next = run(queueOf(item), { type: "tick", now: item.sendAt });
    expect(next.items[0]?.state).toBe("queued");
  });

  it("does not close early", () => {
    const item = itemFrom();
    const state = queueOf(item);
    const next = queueReducer(state, { type: "tick", now: item.sendAt - 1 });
    expect(next.items[0]?.state).toBe("captured");
    // Same reference, so React bails out of the re-render. The engine ticks
    // several times a second while a countdown is on screen; a fresh object
    // every time would re-render the whole Photos list for nothing.
    expect(next).toBe(state);
  });

  it("never closes for a capture taken with auto-send off", () => {
    const item = itemFrom({}, false);
    const next = run(queueOf(item), { type: "tick", now: item.sendAt + 60_000 });
    expect(next.items[0]?.state).toBe("captured");
  });

  it("`send` skips the rest of it and pulls the deadline to now", () => {
    const item = itemFrom();
    const next = run(queueOf(item), { type: "send", captureId: item.captureId, now: T0 + 3_000 });
    expect(next.items[0]?.state).toBe("queued");
    // Otherwise the countdown ring would keep drawing over something in flight.
    expect(next.items[0]?.sendAt).toBe(T0 + 3_000);
    expect(next.items[0]?.nextAttemptAt).toBe(T0 + 3_000);
  });

  it("`undo` is terminal", () => {
    const item = itemFrom();
    const next = run(
      queueOf(item),
      { type: "undo", captureId: item.captureId, now: T0 + 1 },
      // A double tap, or a stale timer firing after the row is already gone.
      { type: "tick", now: item.sendAt },
      { type: "send", captureId: item.captureId, now: item.sendAt },
    );
    expect(next.items[0]?.state).toBe("cancelled");
  });
});

describe("illegal transitions are no-ops, not throws", () => {
  it("refuses to revive a cancelled capture", () => {
    const item = itemFrom();
    const cancelled = run(queueOf(item), { type: "cancel", captureId: item.captureId, now: T0 });
    const after = run(
      cancelled,
      { type: "retry", captureId: item.captureId, now: T0 + 1 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 + 2 },
      {
        type: "uploadSucceeded",
        captureId: item.captureId,
        mediaId: "media1",
        now: T0 + 3,
      },
    );
    expect(after.items[0]?.state).toBe("cancelled");
    expect(after.items[0]?.mediaId).toBeUndefined();
  });

  it("ignores a failure that lands after the guest cancelled", () => {
    // The real race: cancel aborts the request, the request rejects, and the
    // rejection handler dispatches. A `failed` row here would offer a retry for
    // something the guest has already thrown away.
    const item = itemFrom();
    const after = run(
      queueOf(item),
      { type: "send", captureId: item.captureId, now: T0 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 + 1 },
      { type: "cancel", captureId: item.captureId, now: T0 + 2 },
      {
        type: "uploadFailed",
        captureId: item.captureId,
        failure: { message: "Network request failed.", permanent: false },
        now: T0 + 3,
      },
    );
    expect(after.items[0]?.state).toBe("cancelled");
  });

  it("ignores progress for something no longer uploading", () => {
    const item = itemFrom();
    const after = run(
      queueOf(item),
      { type: "send", captureId: item.captureId, now: T0 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 },
      { type: "cancel", captureId: item.captureId, now: T0 + 1 },
      { type: "uploadProgress", captureId: item.captureId, progress: 0.7 },
    );
    expect(after.items[0]?.progress).toBe(0);
  });

  it("ignores every action for an unknown captureId", () => {
    const state = queueOf(itemFrom());
    expect(run(state, { type: "cancel", captureId: "nope", now: T0 })).toBe(state);
  });
});

describe("enqueue", () => {
  it("refuses a duplicate captureId", () => {
    // Ids are minted per capture, so a collision means something upstream is
    // reusing one — replacing the row would drop a file already in flight.
    const item = itemFrom();
    const next = run(queueOf(item), {
      type: "enqueue",
      item: { ...item, uri: "file:///other.jpg" },
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.uri).toBe(item.uri);
  });
});

describe("retries and backoff", () => {
  it("parks a failure with the backoff for the attempt it just made", () => {
    const item = itemFrom();
    const after = run(
      queueOf(item),
      { type: "send", captureId: item.captureId, now: T0 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 },
      {
        type: "uploadFailed",
        captureId: item.captureId,
        failure: { message: "Network request failed.", permanent: false },
        now: T0 + 500,
      },
    );
    const failed = after.items[0];
    expect(failed?.state).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.nextAttemptAt).toBe(T0 + 500 + RETRY_BACKOFF_MS[0]);
  });

  it("honours a server-supplied retryAfterMs over the table", () => {
    // `requestUploadGrant` returns `throttled` with an exact wait. Guessing a
    // shorter one just spends the guest's battery being refused again.
    const item = itemFrom();
    const after = run(
      queueOf(item),
      { type: "send", captureId: item.captureId, now: T0 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 },
      {
        type: "uploadFailed",
        captureId: item.captureId,
        failure: { message: "Slow down a moment.", permanent: false },
        retryAfterMs: 47_000,
        now: T0,
      },
    );
    expect(after.items[0]?.nextAttemptAt).toBe(T0 + 47_000);
  });

  it("lengthens the wait as attempts accumulate, then holds at the last step", () => {
    expect(backoffMsFor(1)).toBe(RETRY_BACKOFF_MS[0]);
    expect(backoffMsFor(2)).toBe(RETRY_BACKOFF_MS[1]);
    expect(backoffMsFor(RETRY_BACKOFF_MS.length)).toBe(
      RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1],
    );
    expect(backoffMsFor(MAX_AUTO_ATTEMPTS)).toBe(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
    // Defensive: a persisted row from a future build could carry 0.
    expect(backoffMsFor(0)).toBe(RETRY_BACKOFF_MS[0]);
  });

  it("a manual retry clears the wait and the message but keeps the attempt count", () => {
    // Resetting `attempts` would let a bored guest tapping Retry re-arm the whole
    // automatic ladder, which is how a dead upload becomes a battery drain.
    const item = itemFrom();
    const failed = run(
      queueOf(item),
      { type: "send", captureId: item.captureId, now: T0 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 },
      {
        type: "uploadFailed",
        captureId: item.captureId,
        failure: { message: "That party is paused.", permanent: true },
        now: T0,
      },
    );
    const retried = run(failed, { type: "retry", captureId: item.captureId, now: T0 + 60_000 });
    expect(retried.items[0]?.state).toBe("queued");
    expect(retried.items[0]?.nextAttemptAt).toBe(T0 + 60_000);
    expect(retried.items[0]?.failure).toBeUndefined();
    expect(retried.items[0]?.attempts).toBe(1);
  });
});

describe("resume", () => {
  it("puts anything left uploading back in the queue", () => {
    const item = itemFrom();
    const inFlight = run(
      queueOf(item),
      { type: "send", captureId: item.captureId, now: T0 },
      { type: "uploadStarted", captureId: item.captureId, now: T0 },
      { type: "uploadProgress", captureId: item.captureId, progress: 0.4 },
    );
    expect(inFlight.items[0]?.state).toBe("uploading");

    const resumed = run(inFlight, { type: "resume", now: T0 + 30_000 });
    expect(resumed.items[0]?.state).toBe("queued");
    // The bar must not resume from where a dead socket left it.
    expect(resumed.items[0]?.progress).toBe(0);
  });

  it("leaves everything else alone", () => {
    const state = queueOf(itemFrom(), itemFrom({ captureId: "capture0002" }, false));
    expect(run(state, { type: "resume", now: T0 + 1 })).toBe(state);
  });
});

describe("hydrate", () => {
  it("marks the queue ready and rescues a mid-flight row from the last process", () => {
    // A request cannot outlive the process that made it, so a persisted
    // `uploading` is always a lie by the time it is read back.
    const stranded: QueueItem = { ...itemFrom(), state: "uploading", progress: 0.6, attempts: 1 };
    const state = queueReducer(EMPTY_QUEUE, {
      type: "hydrate",
      items: [stranded],
      now: T0 + 500_000,
    });
    expect(state.hydrated).toBe(true);
    expect(state.items[0]?.state).toBe("queued");
    expect(state.items[0]?.progress).toBe(0);
    expect(state.items[0]?.attempts).toBe(1);
  });
});

describe("forgetting", () => {
  it("drops undone captures sooner than sent ones", () => {
    const sent: QueueItem = { ...itemFrom(), state: "uploaded", updatedAt: T0 };
    const undone: QueueItem = {
      ...itemFrom({ captureId: "capture0002" }),
      state: "cancelled",
      updatedAt: T0,
    };
    const policy = { uploadedKeepMs: 300_000, cancelledKeepMs: 5_000 };

    const early = forgettableItems([sent, undone], T0 + 10_000, policy);
    expect(early.map((item) => item.captureId)).toEqual(["capture0002"]);

    const later = forgettableItems([sent, undone], T0 + 400_000, policy);
    expect(later).toHaveLength(2);
  });

  it("never forgets something still on its way", () => {
    const item = itemFrom();
    expect(
      forgettableItems([item], T0 + 10_000_000, { uploadedKeepMs: 0, cancelledKeepMs: 0 }),
    ).toEqual([]);
  });

  it("`forget` removes exactly the named rows", () => {
    const a = itemFrom();
    const b = itemFrom({ captureId: "capture0002" });
    const next = run(queueOf(a, b), { type: "forget", captureIds: [a.captureId] });
    expect(next.items.map((item) => item.captureId)).toEqual(["capture0002"]);
  });
});

describe("selectors", () => {
  const mine = itemFrom({ captureId: "capture0001", capturedAt: T0 });
  const alsoMine = itemFrom({ captureId: "capture0002", capturedAt: T0 + 5_000 });
  const elsewhere = itemFrom({ captureId: "capture0003", eventId: "event2" });
  const items = [mine, alsoMine, elsewhere];

  it("scopes to one party, newest first", () => {
    expect(itemsForEvent(items, "event1").map((item) => item.captureId)).toEqual([
      "capture0002",
      "capture0001",
    ]);
  });

  it("returns nothing when no party is selected", () => {
    expect(itemsForEvent(items, null)).toEqual([]);
    expect(pendingCountForEvent(items, undefined)).toBe(0);
  });

  it("offers the newest still-undoable capture", () => {
    expect(undoableItem(items, "event1")?.captureId).toBe("capture0002");
  });

  it("stops offering undo once the window has shut", () => {
    const sent = run(
      { hydrated: true, items },
      { type: "tick", now: T0 + DEFAULT_UNDO_DELAY_MS + 10_000 },
    );
    expect(undoableItem(sent.items, "event1")).toBeUndefined();
  });

  it("counts only what is still on its way", () => {
    const done = run(
      { hydrated: true, items },
      { type: "cancel", captureId: "capture0001", now: T0 },
    );
    expect(pendingCountForEvent(done.items, "event1")).toBe(1);
  });
});
