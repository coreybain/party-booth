import { UPLOAD_REJECTION_MESSAGES } from "@partybooth/contracts/upload";
import { describe, expect, it } from "vitest";

import {
  hasPendingWork,
  isPermanentRejection,
  nextRunnable,
  nextWakeUpAt,
  readGrantResult,
} from "./queue-engine";
import { MAX_AUTO_ATTEMPTS, queueItemFromDraft } from "./queue-reducer";
import type { CaptureDraft, QueueItem } from "./types";

const T0 = 1_700_000_000_000;

function base(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    captureId: "capture0001",
    eventId: "event1",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///captures/capture0001-original.jpg",
    previewUri: "file:///captures/capture0001-preview.jpg",
    byteSize: 1_000,
    mimeType: "image/jpeg",
    checksum: "c".repeat(64),
    capturedAt: T0,
    sourceMetadataStripped: true,
    ...overrides,
  };
}

function item(overrides: Partial<QueueItem> = {}, draft: Partial<CaptureDraft> = {}): QueueItem {
  return {
    ...queueItemFromDraft(base(draft), { autoSend: true, undoDelayMs: 15_000 }, T0),
    ...overrides,
  };
}

describe("nextRunnable", () => {
  it("takes the oldest capture first", () => {
    // The queue is a queue. On party wifi the difference is visible: the host
    // sees the cake being cut before they see the shot after it.
    const older = item({ state: "queued", nextAttemptAt: T0 }, { captureId: "capture0001" });
    const newer = item(
      { state: "queued", nextAttemptAt: T0, capturedAt: T0 + 10_000 },
      { captureId: "capture0002", capturedAt: T0 + 10_000 },
    );
    expect(nextRunnable([newer, older], T0 + 20_000)?.captureId).toBe("capture0001");
  });

  it("ignores a capture still inside its undo window", () => {
    expect(nextRunnable([item()], T0 + 1_000)).toBeUndefined();
  });

  it("ignores a backoff that has not matured", () => {
    const failed = item({ state: "failed", nextAttemptAt: T0 + 30_000, attempts: 1 });
    expect(nextRunnable([failed], T0 + 10_000)).toBeUndefined();
    expect(nextRunnable([failed], T0 + 30_000)?.captureId).toBe("capture0001");
  });

  it("never retries a permanent failure on a timer", () => {
    // "That photo is too big" does not get better by waiting. The Photos tab
    // still offers a button; a phone deciding for the guest is a different thing.
    const permanent = item({
      state: "failed",
      nextAttemptAt: T0,
      attempts: 1,
      failure: { message: "That file is too big.", permanent: true },
    });
    expect(nextRunnable([permanent], T0 + 600_000)).toBeUndefined();
  });

  it("stops automatic attempts once the ladder is exhausted", () => {
    const exhausted = item({
      state: "failed",
      nextAttemptAt: T0,
      attempts: MAX_AUTO_ATTEMPTS,
      failure: { message: "Network request failed.", permanent: false },
    });
    expect(nextRunnable([exhausted], T0 + 1)).toBeUndefined();

    const oneShort = item({ ...exhausted, attempts: MAX_AUTO_ATTEMPTS - 1 });
    expect(nextRunnable([oneShort], T0 + 1)?.captureId).toBe("capture0001");
  });

  it("ignores terminal rows entirely", () => {
    const done = item({ state: "uploaded", nextAttemptAt: 0 });
    const gone = item({ state: "cancelled", nextAttemptAt: 0 });
    expect(nextRunnable([done, gone], T0 + 999_999)).toBeUndefined();
  });
});

describe("nextWakeUpAt", () => {
  it("is when the earliest undo window shuts", () => {
    expect(nextWakeUpAt([item()], T0)).toBe(T0 + 15_000);
  });

  it("is never, for a capture waiting on a human", () => {
    // Auto-send off means there is no deadline to keep, so no timer should run.
    expect(nextWakeUpAt([item({ autoSend: false })], T0)).toBeNull();
  });

  it("is never, for an empty or finished queue", () => {
    expect(nextWakeUpAt([], T0)).toBeNull();
    expect(nextWakeUpAt([item({ state: "uploaded" })], T0)).toBeNull();
  });

  it("is the soonest of several", () => {
    const soon = item({ state: "failed", nextAttemptAt: T0 + 2_000, attempts: 1 });
    const later = item({ state: "failed", nextAttemptAt: T0 + 40_000, attempts: 1 });
    expect(nextWakeUpAt([later, soon], T0)).toBe(T0 + 2_000);
  });

  it("does not schedule a wake-up for a permanent failure", () => {
    const permanent = item({
      state: "failed",
      nextAttemptAt: T0 + 1_000,
      attempts: 1,
      failure: { message: "That capture was withdrawn.", permanent: true },
    });
    expect(nextWakeUpAt([permanent], T0)).toBeNull();
  });
});

describe("hasPendingWork", () => {
  it("is false only when everything is terminal", () => {
    expect(hasPendingWork([])).toBe(false);
    expect(hasPendingWork([item({ state: "uploaded" }), item({ state: "cancelled" })])).toBe(false);
    expect(hasPendingWork([item({ state: "uploaded" }), item({ state: "failed" })])).toBe(true);
  });
});

describe("readGrantResult", () => {
  it("passes the whole grant through, because the ticket is built from it", () => {
    const grant = {
      outcome: "granted",
      grantId: "grant1",
      secret: "s".repeat(32),
      eventId: "event1",
      captureId: "capture0001",
      mediaType: "photo",
      mediaSource: "capture",
      storageRegion: "pdx1",
      byteSize: 1_000,
      maxBytes: 20 * 1024 * 1024,
      expiresAt: T0 + 120_000,
    } as const;

    // Not just the secret: `buildUploadTicket` takes `eventId`, `captureId`,
    // `mediaType` and `byteSize` off the grant, so the queue has to keep it.
    expect(readGrantResult(grant)).toEqual({ kind: "granted", grant });
  });

  it("turns a throttle into a wait of exactly the length the server asked for", () => {
    const outcome = readGrantResult({
      outcome: "throttled",
      message: "Slow down a moment — too many uploads at once.",
      retryAfterMs: 42_000,
    });
    expect(outcome).toEqual({
      kind: "failed",
      failure: { message: "Slow down a moment — too many uploads at once.", permanent: false },
      retryAfterMs: 42_000,
    });
  });

  it("keeps a paused party retryable", () => {
    // The single most likely refusal at a real party: a host pauses to catch up
    // on moderation and un-pauses two minutes later. The guest must not have to
    // remember to press anything.
    const outcome = readGrantResult({
      outcome: "rejected",
      reason: "eventNotAcceptingUploads",
      message: UPLOAD_REJECTION_MESSAGES.eventNotAcceptingUploads,
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.failure.permanent).toBe(false);
  });

  it("stops trying on a fact about the file", () => {
    for (const reason of ["tooLarge", "unsupportedMimeType", "captureWithdrawn"] as const) {
      const outcome = readGrantResult({
        outcome: "rejected",
        reason,
        message: UPLOAD_REJECTION_MESSAGES[reason],
      });
      expect(outcome.kind === "failed" && outcome.failure.permanent).toBe(true);
      // The guest reads the contract's words, which are the same ones apps/web
      // shows for the same refusal.
      expect(outcome.kind === "failed" && outcome.failure.message).toBe(
        UPLOAD_REJECTION_MESSAGES[reason],
      );
    }
  });

  it("treats the host's library switch as something that can be turned back on", () => {
    expect(isPermanentRejection("libraryImportDisabled")).toBe(false);
  });
});
