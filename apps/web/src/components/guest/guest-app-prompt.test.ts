import { describe, expect, it } from "vitest";

import { appPromptWasDismissed, GUEST_APP_PROMPT_DISMISSED_KEY } from "./guest-app-prompt";

describe("guest app prompt", () => {
  it("uses a versioned storage key", () => {
    expect(GUEST_APP_PROMPT_DISMISSED_KEY).toMatch(/:v\d+$/);
  });

  it("only treats the explicit persisted value as dismissed", () => {
    expect(appPromptWasDismissed("1")).toBe(true);
    expect(appPromptWasDismissed(null)).toBe(false);
    expect(appPromptWasDismissed("0")).toBe(false);
  });
});
