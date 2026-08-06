import { describe, expect, it } from "vitest";

import { guestEventTabForKey, guestEventTabFromHash } from "./guest-event-tabs";

describe("guest event tabs", () => {
  it("restores current and legacy gallery hashes", () => {
    expect(guestEventTabFromHash("#gallery")).toBe("gallery");
    expect(guestEventTabFromHash("#party-gallery")).toBe("gallery");
    expect(guestEventTabFromHash("#your-uploads")).toBe("gallery");
    expect(guestEventTabFromHash("#settings")).toBe("settings");
    expect(guestEventTabFromHash("#unknown")).toBe("camera");
  });

  it("supports the standard arrow, home, and end tab keys", () => {
    expect(guestEventTabForKey("camera", "ArrowLeft")).toBe("settings");
    expect(guestEventTabForKey("settings", "ArrowRight")).toBe("camera");
    expect(guestEventTabForKey("gallery", "Home")).toBe("camera");
    expect(guestEventTabForKey("gallery", "End")).toBe("settings");
    expect(guestEventTabForKey("gallery", "Enter")).toBeNull();
  });
});
