import { describe, expect, it } from "vitest";

import { resolveDisplayName } from "./profile";

/**
 * The rule under test is one sentence — a provider name is a default, and a
 * default never overwrites a choice — but the failure it prevents is expensive
 * and silent: a guest confirms "Sam", verifies their email an hour later, the
 * `user.onUpdate` trigger fires, and the host's moderation queue quietly starts
 * saying "Samantha Smith" again.
 */
describe("resolveDisplayName", () => {
  const CONFIRMED = 1_700_000_000_000;

  it("takes the provider's name before the human has chosen one", () => {
    expect(
      resolveDisplayName({
        current: "sam",
        providerName: "Samantha Smith",
        onboardedAt: undefined,
      }),
    ).toBe("Samantha Smith");
  });

  it("keeps a confirmed name whatever the provider says", () => {
    expect(
      resolveDisplayName({
        current: "Sam",
        providerName: "Samantha Smith",
        onboardedAt: CONFIRMED,
      }),
    ).toBe("Sam");
  });

  it("does not let a blank or missing provider name erase what is there", () => {
    for (const providerName of [undefined, null, "", "   "]) {
      expect(resolveDisplayName({ current: "sam", providerName, onboardedAt: undefined })).toBe(
        "sam",
      );
    }
  });

  it("trims what the provider sent", () => {
    expect(
      resolveDisplayName({ current: "sam", providerName: "  Sam  ", onboardedAt: undefined }),
    ).toBe("Sam");
  });
});
