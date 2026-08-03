import { describe, expect, it } from "vitest";

import { playableUrlOf, reviewUrlOf, stillUrlOf } from "@/components/media/media-tile";
import type { MediaItem } from "@/lib/convex-api";

/**
 * The URL precedence is a privacy rule wearing a performance rule's clothes, so
 * it gets a test even though the component around it does not (this app has no
 * DOM test environment — see `vitest.config.ts`).
 *
 * The still prefers the **derivative**, which for a fellow guest is frequently
 * the only thing present at all; the playable source prefers the **original**,
 * which is the only complete file. Swapping either one silently degrades a
 * gallery or silently withholds a video from the person allowed to watch it.
 */
function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m1",
    eventId: "e1",
    captureId: "cap1",
    state: "approved",
    mediaType: "photo",
    fromLibrary: false,
    byteSize: 1_024,
    mimeType: "image/jpeg",
    uploaderUserId: "u1",
    uploaderDisplayName: "Ada",
    isOwn: false,
    createdAt: 1,
    ...overrides,
  };
}

describe("which URL a tile uses", () => {
  it("shows the poster first, then the preview, then the original", () => {
    expect(stillUrlOf(item({ posterUrl: "poster", previewUrl: "preview", url: "original" }))).toBe(
      "poster",
    );
    expect(stillUrlOf(item({ previewUrl: "preview", url: "original" }))).toBe("preview");
    expect(stillUrlOf(item({ url: "original" }))).toBe("original");
    expect(stillUrlOf(item())).toBeUndefined();
  });

  it("plays the original first, and falls back to the derivative", () => {
    expect(playableUrlOf(item({ url: "original", previewUrl: "preview" }))).toBe("original");
    expect(playableUrlOf(item({ previewUrl: "preview" }))).toBe("preview");
  });

  it("has nothing to play for a video that was withheld from this viewer", () => {
    // A video original is never marked as re-encoded (no browser can do it), so
    // `mayServeOriginal` withholds it from a fellow guest and only the poster
    // comes back. The tile must show the poster and no play button.
    const withheld = item({ mediaType: "video", posterUrl: "poster" });
    expect(stillUrlOf(withheld)).toBe("poster");
    expect(playableUrlOf(withheld)).toBeUndefined();
  });

  it("reviews the original first and falls back to a derivative", () => {
    expect(reviewUrlOf(item({ url: "original", previewUrl: "preview" }))).toBe("original");
    expect(reviewUrlOf(item({ previewUrl: "preview" }))).toBe("preview");
    expect(reviewUrlOf(item({ posterUrl: "poster" }))).toBe("poster");
  });
});
