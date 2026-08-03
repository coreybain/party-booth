import { describe, expect, it } from "vitest";

import { ZOOM_DRAG_RANGE_PX, zoomFromVerticalDrag } from "./camera-zoom";

describe("vertical camera zoom", () => {
  it("zooms in while the held shutter moves upward", () => {
    expect(zoomFromVerticalDrag(0, 400, 400 - ZOOM_DRAG_RANGE_PX / 2)).toBe(0.5);
  });

  it("returns toward the starting zoom when the finger moves back down", () => {
    expect(zoomFromVerticalDrag(0.5, 400, 460)).toBe(0.25);
  });

  it("clamps to the native camera range", () => {
    expect(zoomFromVerticalDrag(0.8, 400, 0)).toBe(1);
    expect(zoomFromVerticalDrag(0.2, 400, 700)).toBe(0);
  });
});
