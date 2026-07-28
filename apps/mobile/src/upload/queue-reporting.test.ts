/**
 * When the queue is allowed to buzz somebody's phone.
 *
 * The two failure modes this pins down are the ones that would be discovered at
 * a party: reporting a *transient* failure (so a guest is told their photo did
 * not send, ten seconds before it does), and reporting a recovery that was never
 * preceded by a failure (so "sent after all" arrives about a photo nobody was
 * worried about).
 */

import { describe, expect, it } from "vitest";

import { MAX_AUTO_ATTEMPTS } from "./queue-reducer";
import { hasGivenUp, nextReportedSet, queueReportsFor } from "./queue-reporting";

import type { QueueItem } from "./types";

function anItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    captureId: "cap1",
    eventId: "ev1",
    state: "queued",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///cap1.jpg",
    previewUri: "file:///cap1-thumb.jpg",
    byteSize: 1024,
    mimeType: "image/jpeg",
    checksum: "abc",
    capturedAt: 1_000,
    sourceMetadataStripped: true,
    derivatives: [],
    autoSend: true,
    sendAt: 1_000,
    undoDelayMs: 15_000,
    attempts: 0,
    nextAttemptAt: 0,
    progress: 0,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("hasGivenUp", () => {
  it("is false while the engine still intends to retry", () => {
    const item = anItem({
      state: "failed",
      attempts: 2,
      failure: { message: "Network hiccup", permanent: false },
    });
    expect(hasGivenUp(item)).toBe(false);
  });

  it("is true the moment a refusal is permanent", () => {
    // "The party is over", "that file is too big", "this was withdrawn". No
    // number of retries fixes any of them, so the guest should hear now.
    const item = anItem({
      state: "failed",
      attempts: 1,
      failure: { message: "This party is not accepting photos.", permanent: true },
    });
    expect(hasGivenUp(item)).toBe(true);
  });

  it("is true once the automatic retries are spent", () => {
    const item = anItem({
      state: "failed",
      attempts: MAX_AUTO_ATTEMPTS,
      failure: { message: "Still offline", permanent: false },
    });
    expect(hasGivenUp(item)).toBe(true);
  });

  it("is false for a capture that is merely in flight", () => {
    expect(hasGivenUp(anItem({ state: "uploading" }))).toBe(false);
    expect(hasGivenUp(anItem({ state: "uploaded" }))).toBe(false);
  });
});

describe("queueReportsFor", () => {
  it("reports nothing about a healthy queue", () => {
    expect(queueReportsFor([anItem(), anItem({ captureId: "cap2" })], new Set())).toEqual([]);
  });

  it("reports a failure exactly once", () => {
    const item = anItem({
      state: "failed",
      attempts: MAX_AUTO_ATTEMPTS,
      failure: { message: "Gone", permanent: true },
    });

    const first = queueReportsFor([item], new Set());
    expect(first).toEqual([
      { eventId: "ev1", captureId: "cap1", event: "failed", attempts: MAX_AUTO_ATTEMPTS },
    ]);

    // Second pass, with the set updated — the queue re-renders on every progress
    // event, so "once" is the only acceptable answer.
    const reported = nextReportedSet(new Set(), first, [item]);
    expect(queueReportsFor([item], reported)).toEqual([]);
  });

  it("reports a recovery only after a failure was reported", () => {
    const uploaded = anItem({ state: "uploaded", attempts: 3 });

    expect(queueReportsFor([uploaded], new Set())).toEqual([]);
    expect(queueReportsFor([uploaded], new Set(["cap1"]))).toEqual([
      { eventId: "ev1", captureId: "cap1", event: "recovered", attempts: 3 },
    ]);
  });

  it("does not report a cancelled capture as recovered", () => {
    // They pressed Undo. They know.
    const cancelled = anItem({ state: "cancelled" });
    expect(queueReportsFor([cancelled], new Set(["cap1"]))).toEqual([]);
  });
});

describe("nextReportedSet", () => {
  it("remembers a failure and forgets it on recovery", () => {
    const item = anItem();
    const afterFailure = nextReportedSet(
      new Set(),
      [{ eventId: "ev1", captureId: "cap1", event: "failed", attempts: 8 }],
      [item],
    );
    expect([...afterFailure]).toEqual(["cap1"]);

    const afterRecovery = nextReportedSet(
      afterFailure,
      [{ eventId: "ev1", captureId: "cap1", event: "recovered", attempts: 8 }],
      [item],
    );
    expect([...afterRecovery]).toEqual([]);
  });

  it("drops captures the queue has swept, so the set cannot grow all night", () => {
    const kept = nextReportedSet(new Set(["cap1", "cap2"]), [], [anItem({ captureId: "cap2" })]);
    expect([...kept]).toEqual(["cap2"]);
  });
});
