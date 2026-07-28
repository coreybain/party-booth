import { CAPTURE_UNDO_WINDOW_MS, MEDIA_TYPES } from "@partybooth/contracts/media";
import { describe, expect, it } from "vitest";

import { UNDO_DELAY_MAX_MS } from "./countdown";
import {
  autoSendsFor,
  DEFAULT_CAPTURE_SETTINGS,
  describeUndoDelay,
  normaliseCaptureSettings,
  parseCaptureSettings,
  serialiseCaptureSettings,
  withAutoSend,
  withUndoDelay,
} from "./settings";

describe("defaults", () => {
  it("auto-send is on for every media type, per PLAN", () => {
    for (const mediaType of MEDIA_TYPES) {
      expect(autoSendsFor(DEFAULT_CAPTURE_SETTINGS, mediaType)).toBe(true);
    }
  });

  it("the undo window is the contract's fifteen seconds", () => {
    expect(DEFAULT_CAPTURE_SETTINGS.undoDelayMs).toBe(CAPTURE_UNDO_WINDOW_MS);
  });
});

describe("changes", () => {
  it("turns one type off without touching the other", () => {
    const next = withAutoSend(DEFAULT_CAPTURE_SETTINGS, "video", false);
    expect(next.autoSend.video).toBe(false);
    expect(next.autoSend.photo).toBe(true);
    // Immutable: the settings object is held in React state.
    expect(DEFAULT_CAPTURE_SETTINGS.autoSend.video).toBe(true);
  });

  it("clamps a delay on the way in rather than on the way out", () => {
    expect(withUndoDelay(DEFAULT_CAPTURE_SETTINGS, 999_999).undoDelayMs).toBe(UNDO_DELAY_MAX_MS);
    expect(withUndoDelay(DEFAULT_CAPTURE_SETTINGS, -5).undoDelayMs).toBe(0);
  });
});

describe("reading what a previous build wrote", () => {
  it("round-trips", () => {
    const settings = withUndoDelay(withAutoSend(DEFAULT_CAPTURE_SETTINGS, "photo", false), 30_000);
    expect(parseCaptureSettings(serialiseCaptureSettings(settings))).toEqual(settings);
  });

  it("treats absent, empty and malformed the same as never saved", () => {
    for (const raw of [null, undefined, "", "{{{", "[]", "7"]) {
      expect(parseCaptureSettings(raw)).toEqual(DEFAULT_CAPTURE_SETTINGS);
    }
  });

  it("fills in a media type a previous version did not know about", () => {
    // The failure this prevents: Sprint 4 ships video, and a guest who saved
    // settings in Sprint 3 gets `undefined` for `autoSend.video` — which is
    // falsy, so their videos would silently never send.
    const partial = normaliseCaptureSettings({ autoSend: { photo: false } });
    expect(partial.autoSend.photo).toBe(false);
    expect(partial.autoSend.video).toBe(DEFAULT_CAPTURE_SETTINGS.autoSend.video);
  });

  it("ignores a value of the wrong type rather than coercing it", () => {
    const odd = normaliseCaptureSettings({ autoSend: { photo: "yes" }, undoDelayMs: "30000" });
    expect(odd.autoSend.photo).toBe(true);
    expect(odd.undoDelayMs).toBe(DEFAULT_CAPTURE_SETTINGS.undoDelayMs);
  });

  it("survives autoSend being something other than an object", () => {
    expect(normaliseCaptureSettings({ autoSend: null })).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(normaliseCaptureSettings({ autoSend: "all" })).toEqual(DEFAULT_CAPTURE_SETTINGS);
  });
});

describe("describeUndoDelay", () => {
  it("says what zero actually means", () => {
    // "0 seconds to undo" reads as a bug; it is a deliberate setting.
    expect(describeUndoDelay(0)).toBe("Send immediately");
  });

  it("uses minutes at the top of the range", () => {
    expect(describeUndoDelay(60_000)).toBe("1 minute to undo");
  });

  it("counts seconds in between", () => {
    expect(describeUndoDelay(15_000)).toBe("15 seconds to undo");
  });
});
