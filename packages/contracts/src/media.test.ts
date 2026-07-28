import { describe, expect, it } from "vitest";

import {
  allowedMimeTypes,
  CAPTURE_STATES,
  captureStateMachine,
  CAPTURE_UNDO_WINDOW_MS,
  isCaptureInFlight,
  isTerminalCapture,
  maxBytesFor,
  MEDIA_LIMITS,
  PHOTO_MAX_BYTES,
  TERMINAL_CAPTURE_STATES,
  validateMediaFile,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
} from "./media";

const MIB = 1024 * 1024;

describe("per-file limits", () => {
  it("matches the numbers in PLAN.md", () => {
    expect(PHOTO_MAX_BYTES).toBe(20 * MIB);
    expect(VIDEO_MAX_BYTES).toBe(250 * MIB);
    expect(VIDEO_MAX_DURATION_SECONDS).toBe(60);
    expect(CAPTURE_UNDO_WINDOW_MS).toBe(15_000);
  });

  it("exposes the limit per media type", () => {
    expect(maxBytesFor("photo")).toBe(MEDIA_LIMITS.photo.maxBytes);
    expect(maxBytesFor("video")).toBe(MEDIA_LIMITS.video.maxBytes);
  });

  it("accepts the formats iPhones and Androids actually produce", () => {
    expect(allowedMimeTypes("photo")).toContain("image/heic");
    expect(allowedMimeTypes("photo")).toContain("image/jpeg");
    expect(allowedMimeTypes("video")).toContain("video/quicktime");
    expect(allowedMimeTypes("video")).toContain("video/mp4");
  });
});

describe("validateMediaFile — photos", () => {
  const photo = (over: Partial<Parameters<typeof validateMediaFile>[0]> = {}) =>
    validateMediaFile({ mediaType: "photo", byteSize: MIB, mimeType: "image/jpeg", ...over });

  it("accepts a normal photo", () => {
    expect(photo()).toEqual({ ok: true });
  });

  it("accepts a photo exactly on the limit", () => {
    expect(photo({ byteSize: PHOTO_MAX_BYTES })).toEqual({ ok: true });
  });

  it("rejects one byte over", () => {
    const result = photo({ byteSize: PHOTO_MAX_BYTES + 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("tooLarge");
    expect(result.ok === false && result.limit).toBe(PHOTO_MAX_BYTES);
    expect(result.ok === false && result.message).toContain("20 MB");
  });

  it("rejects an empty file", () => {
    expect(photo({ byteSize: 0 })).toMatchObject({ ok: false, reason: "emptyFile" });
    expect(photo({ byteSize: -1 })).toMatchObject({ ok: false, reason: "emptyFile" });
    expect(photo({ byteSize: Number.NaN })).toMatchObject({ ok: false, reason: "emptyFile" });
  });

  it("rejects a format we cannot render", () => {
    expect(photo({ mimeType: "image/tiff" })).toMatchObject({
      ok: false,
      reason: "unsupportedMimeType",
    });
  });

  it("skips the format check when the client cannot tell us the type", () => {
    expect(photo({ mimeType: undefined })).toEqual({ ok: true });
  });

  it("ignores duration for photos", () => {
    expect(photo({ durationSeconds: 999 })).toEqual({ ok: true });
  });
});

describe("validateMediaFile — videos", () => {
  const video = (over: Partial<Parameters<typeof validateMediaFile>[0]> = {}) =>
    validateMediaFile({
      mediaType: "video",
      byteSize: 10 * MIB,
      mimeType: "video/mp4",
      durationSeconds: 12,
      ...over,
    });

  it("accepts a normal video", () => {
    expect(video()).toEqual({ ok: true });
  });

  it("accepts one exactly on both limits", () => {
    expect(video({ byteSize: VIDEO_MAX_BYTES, durationSeconds: 60 })).toEqual({ ok: true });
  });

  it("rejects a video over 250 MB", () => {
    expect(video({ byteSize: VIDEO_MAX_BYTES + 1 })).toMatchObject({
      ok: false,
      reason: "tooLarge",
    });
  });

  it("rejects a video over 60 seconds", () => {
    const result = video({ durationSeconds: 60.5 });
    expect(result).toMatchObject({ ok: false, reason: "tooLong" });
    expect(result.ok === false && result.limit).toBe(60);
  });

  it("insists on knowing the duration", () => {
    expect(video({ durationSeconds: undefined })).toMatchObject({
      ok: false,
      reason: "missingDuration",
    });
    expect(video({ durationSeconds: Number.NaN })).toMatchObject({
      ok: false,
      reason: "missingDuration",
    });
  });

  it("checks size before duration, so the cheaper rejection wins", () => {
    expect(video({ byteSize: VIDEO_MAX_BYTES + 1, durationSeconds: 999 })).toMatchObject({
      ok: false,
      reason: "tooLarge",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Capture-state predicates, shared by both clients                           */
/* -------------------------------------------------------------------------- */

describe("isTerminalCapture", () => {
  it("agrees with the state machine on every state", () => {
    for (const state of CAPTURE_STATES) {
      expect(isTerminalCapture(state)).toBe(captureStateMachine.isTerminal(state));
    }
  });

  it("is the two a queue may stop watching", () => {
    expect([...TERMINAL_CAPTURE_STATES].sort()).toEqual(["cancelled", "uploaded"]);
  });

  it("does not treat a retryable failure as finished", () => {
    expect(isTerminalCapture("failed")).toBe(false);
  });
});

describe("isCaptureInFlight", () => {
  it("is true only while something is happening without the guest", () => {
    expect(isCaptureInFlight("queued")).toBe(true);
    expect(isCaptureInFlight("uploading")).toBe(true);
  });

  it("excludes captured, which is waiting on a countdown or a human", () => {
    expect(isCaptureInFlight("captured")).toBe(false);
  });

  it("excludes failed, which has something to say to the guest", () => {
    expect(isCaptureInFlight("failed")).toBe(false);
  });

  it("never overlaps with a terminal state", () => {
    for (const state of CAPTURE_STATES) {
      expect(isCaptureInFlight(state) && isTerminalCapture(state)).toBe(false);
    }
  });
});
