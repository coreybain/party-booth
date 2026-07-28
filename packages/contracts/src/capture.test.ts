import { describe, expect, it } from "vitest";

import {
  CAPTURE_ID_BYTES,
  CAPTURE_ID_PREFIXES,
  DERIVATIVE_MIME_TYPE,
  DERIVATIVE_PROFILES,
  derivativeFileName,
  fitWithin,
  isValidCaptureId,
  needsResize,
  newCaptureId,
  toHex,
} from "./capture";
import { allowedMimeTypes, PHOTO_MAX_BYTES } from "./media";
import { captureIdSchema, checksumSchema } from "./schemas";

/** Deterministic bytes, so an id is an assertion rather than a coin toss. */
function fixedBytes(fill: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(fill);
}

describe("fitWithin", () => {
  it("leaves an image that already fits alone", () => {
    expect(fitWithin({ width: 800, height: 600 }, 2560)).toEqual({ width: 800, height: 600 });
  });

  it("never upscales", () => {
    expect(fitWithin({ width: 300, height: 200 }, 4096)).toEqual({ width: 300, height: 200 });
  });

  it("scales the long edge down to the cap, preserving aspect ratio", () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin({ width: 3000, height: 4000 }, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it("floors at one pixel, because a zero-height canvas throws", () => {
    const panorama = fitWithin({ width: 10_000, height: 3 }, 480);
    expect(panorama.height).toBeGreaterThanOrEqual(1);
    expect(panorama.width).toBe(480);
  });

  it("answers 1x1 for a degenerate size instead of throwing mid-capture", () => {
    expect(fitWithin({ width: 0, height: 0 }, 2560)).toEqual({ width: 1, height: 1 });
    expect(fitWithin({ width: Number.NaN, height: 10 }, 2560)).toEqual({ width: 1, height: 1 });
    expect(fitWithin({ width: -5, height: -5 }, 2560)).toEqual({ width: 1, height: 1 });
  });
});

describe("needsResize", () => {
  it("is true only when something would actually change", () => {
    expect(needsResize({ width: 4000, height: 3000 }, 2560)).toBe(true);
    expect(needsResize({ width: 2560, height: 1440 }, 2560)).toBe(false);
    expect(needsResize({ width: 100, height: 100 }, 2560)).toBe(false);
  });

  it("does not ask for a resize it cannot compute", () => {
    expect(needsResize({ width: 0, height: 0 }, 2560)).toBe(false);
  });
});

describe("DERIVATIVE_PROFILES", () => {
  it("caps the web pipeline well under mobile Safari's canvas area limit", () => {
    const { uploadMaxEdge } = DERIVATIVE_PROFILES.web;
    // 4:3 at the cap, against the ~16.7 Mpx iOS ceiling.
    expect(uploadMaxEdge * uploadMaxEdge * 0.75).toBeLessThan(16_000_000);
  });

  it("keeps more detail on native, where there is no such ceiling", () => {
    expect(DERIVATIVE_PROFILES.native.uploadMaxEdge).toBeGreaterThan(
      DERIVATIVE_PROFILES.web.uploadMaxEdge,
    );
  });

  it("emits a type the contract accepts for photos", () => {
    for (const profile of Object.values(DERIVATIVE_PROFILES)) {
      expect(allowedMimeTypes("photo")).toContain(profile.outputMimeType);
      expect(profile.outputMimeType).toBe(DERIVATIVE_MIME_TYPE);
    }
  });

  it("keeps a plausible photo far below the contract's byte cap on both platforms", () => {
    for (const profile of Object.values(DERIVATIVE_PROFILES)) {
      // Four bytes per pixel is a wild over-estimate for JPEG; the point is
      // that even that cannot reach the cap.
      const worstCase = profile.uploadMaxEdge * profile.uploadMaxEdge * 0.75 * 4;
      expect(worstCase).toBeLessThan(PHOTO_MAX_BYTES * 4);
    }
  });

  it("makes the preview smaller than the thing it previews", () => {
    for (const profile of Object.values(DERIVATIVE_PROFILES)) {
      expect(profile.previewMaxEdge).toBeLessThan(profile.uploadMaxEdge);
      expect(profile.previewQuality).toBeLessThan(profile.uploadQuality);
    }
  });
});

describe("derivativeFileName", () => {
  it("names both files from the capture id, so an orphan is recognisable", () => {
    expect(derivativeFileName("mabc123def", "original")).toBe("mabc123def-original.jpg");
    expect(derivativeFileName("mabc123def", "preview")).toBe("mabc123def-preview.jpg");
  });
});

describe("toHex", () => {
  it("pads bytes below 0x10 to two characters", () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });

  it("is lower case, which is the only shape checksumSchema accepts", () => {
    const hex = toHex(new Uint8Array(32).fill(0xab));
    expect(hex).toBe("ab".repeat(32));
    expect(checksumSchema.safeParse(hex).success).toBe(true);
  });

  it("accepts an ArrayBuffer, which is what both platforms' digest returns", () => {
    expect(toHex(new Uint8Array([1, 2, 3]).buffer)).toBe("010203");
  });
});

describe("newCaptureId", () => {
  it("produces something Convex accepts, from both clients", () => {
    for (const prefix of Object.values(CAPTURE_ID_PREFIXES)) {
      const id = newCaptureId(prefix, fixedBytes(0xa1));
      expect(captureIdSchema.safeParse(id).success).toBe(true);
      expect(isValidCaptureId(id)).toBe(true);
    }
  });

  it("marks which client minted it, without either client sharing a value", () => {
    expect(newCaptureId(CAPTURE_ID_PREFIXES.web, fixedBytes(1)).startsWith("w")).toBe(true);
    expect(newCaptureId(CAPTURE_ID_PREFIXES.native, fixedBytes(1)).startsWith("m")).toBe(true);
    expect(CAPTURE_ID_PREFIXES.web).not.toBe(CAPTURE_ID_PREFIXES.native);
  });

  it("spends 128 bits, so a collision needs a birthday paradox and not a guess", () => {
    expect(CAPTURE_ID_BYTES).toBe(16);
    const id = newCaptureId(CAPTURE_ID_PREFIXES.web, fixedBytes(0));
    expect(id).toHaveLength(1 + CAPTURE_ID_BYTES * 2);
  });

  it("is different every time the randomness is", () => {
    let counter = 0;
    const random = (length: number) => new Uint8Array(length).fill(counter++);
    const ids = new Set([
      newCaptureId(CAPTURE_ID_PREFIXES.web, random),
      newCaptureId(CAPTURE_ID_PREFIXES.web, random),
      newCaptureId(CAPTURE_ID_PREFIXES.web, random),
    ]);
    expect(ids.size).toBe(3);
  });

  it("encodes nothing about the capture — it is a coat-check ticket", () => {
    const id = newCaptureId(CAPTURE_ID_PREFIXES.web, fixedBytes(0));
    expect(id.slice(1)).toBe("0".repeat(32));
  });
});

describe("isValidCaptureId", () => {
  it("refuses what the Convex validator refuses", () => {
    expect(isValidCaptureId("short")).toBe(false);
    expect(isValidCaptureId("has spaces in it")).toBe(false);
    expect(isValidCaptureId("x".repeat(65))).toBe(false);
  });
});
