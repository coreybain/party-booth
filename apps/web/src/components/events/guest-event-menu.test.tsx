import { describe, expect, it } from "vitest";

import {
  consoleMediaPanelFromHash,
  consoleMediaPanelLabel,
  guestEventMenuItems,
} from "@/components/events/guest-event-menu";

describe("guest event menu", () => {
  it("always offers the guest's own uploads without repeating the visible capture controls", () => {
    expect(guestEventMenuItems(false).map((item) => item.href)).toEqual(["#your-uploads"]);
  });

  it("offers the party gallery only when that section is visible", () => {
    expect(guestEventMenuItems(true).map((item) => item.href)).toEqual([
      "#your-uploads",
      "#party-gallery",
    ]);
  });

  it("turns media hashes into distinct console views", () => {
    expect(consoleMediaPanelFromHash("#your-uploads", true)).toBe("uploads");
    expect(consoleMediaPanelFromHash("#party-gallery", true)).toBe("gallery");
  });

  it("falls back to uploads for legacy hashes and an unavailable gallery", () => {
    expect(consoleMediaPanelFromHash("#add-media", true)).toBe("uploads");
    expect(consoleMediaPanelFromHash("#party-gallery", false)).toBe("uploads");
  });

  it("labels the trigger with the active selection", () => {
    expect(consoleMediaPanelLabel("uploads")).toBe("Your uploads");
    expect(consoleMediaPanelLabel("gallery")).toBe("Party gallery");
  });
});
