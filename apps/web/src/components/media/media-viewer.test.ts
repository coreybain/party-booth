import { describe, expect, it } from "vitest";

import type { MediaItem } from "@/lib/convex-api";

import { adjacentMediaIndex, mediaViewerIndexForScroll, mediaViewerItemOf } from "./media-viewer";

describe("media viewer navigation", () => {
  it("selects the nearest snapped page and clamps the result", () => {
    expect(mediaViewerIndexForScroll(0, 390, 4)).toBe(0);
    expect(mediaViewerIndexForScroll(240, 390, 4)).toBe(1);
    expect(mediaViewerIndexForScroll(2_000, 390, 4)).toBe(3);
    expect(mediaViewerIndexForScroll(-200, 390, 4)).toBe(0);
  });

  it("moves one item at a time without leaving the gallery", () => {
    expect(adjacentMediaIndex(1, -1, 4)).toBe(0);
    expect(adjacentMediaIndex(1, 1, 4)).toBe(2);
    expect(adjacentMediaIndex(0, -1, 4)).toBe(0);
    expect(adjacentMediaIndex(3, 1, 4)).toBe(3);
  });

  it("carries the accepted challenge into the full-screen viewer", () => {
    const item = {
      id: "media_1",
      eventId: "event_1",
      captureId: "capture_1",
      state: "approved",
      mediaType: "photo",
      fromLibrary: false,
      byteSize: 1_024,
      mimeType: "image/jpeg",
      uploaderUserId: "user_1",
      uploaderDisplayName: "Corey",
      isOwn: true,
      createdAt: 1,
      challengePrompt: "Recreate a movie poster",
      url: "https://example.test/photo.jpg",
    } satisfies MediaItem;

    expect(mediaViewerItemOf(item, "Corey's photo")).toMatchObject({
      key: "media_1",
      challengePrompt: "Recreate a movie poster",
    });
  });
});
