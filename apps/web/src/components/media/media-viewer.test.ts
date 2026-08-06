import { describe, expect, it } from "vitest";

import { adjacentMediaIndex, mediaViewerIndexForScroll } from "./media-viewer";

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
});
