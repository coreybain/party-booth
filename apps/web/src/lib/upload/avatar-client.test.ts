import { describe, expect, it } from "vitest";

import { requireSuccessfulAvatarCompletion } from "./avatar-client";

describe("requireSuccessfulAvatarCompletion", () => {
  it("accepts registered and idempotent duplicate completions", () => {
    expect(() => requireSuccessfulAvatarCompletion({ outcome: "registered" })).not.toThrow();
    expect(() => requireSuccessfulAvatarCompletion({ outcome: "duplicate" })).not.toThrow();
  });

  it("rejects a callback that did not attach the avatar", () => {
    expect(() =>
      requireSuccessfulAvatarCompletion({ outcome: "discarded", reason: "fileMismatch" }),
    ).toThrow(/profile photo/i);
  });
});
