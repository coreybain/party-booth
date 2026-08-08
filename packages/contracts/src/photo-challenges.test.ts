import { describe, expect, it } from "vitest";

import {
  normalizePhotoChallengePrompt,
  PHOTO_CHALLENGE_MAX_ACTIVE,
  PHOTO_CHALLENGE_STARTER_DECK,
  photoChallengePromptSchema,
  pickPhotoChallengeIndex,
} from "./photo-challenges";

describe("photo challenges", () => {
  it("ships a balanced starter deck", () => {
    expect(PHOTO_CHALLENGE_STARTER_DECK).toHaveLength(PHOTO_CHALLENGE_MAX_ACTIVE);
    expect(new Set(PHOTO_CHALLENGE_STARTER_DECK)).toHaveLength(PHOTO_CHALLENGE_MAX_ACTIVE);
  });

  it("normalizes event-local duplicate prompts", () => {
    expect(normalizePhotoChallengePrompt("  Biggest   LAUGH  ")).toBe("biggest laugh");
  });

  it("trims valid prompts and rejects empty or overlong ones", () => {
    expect(photoChallengePromptSchema.parse("  Find a reflection  ")).toBe("Find a reflection");
    expect(photoChallengePromptSchema.safeParse("   ").success).toBe(false);
    expect(photoChallengePromptSchema.safeParse("x".repeat(121)).success).toBe(false);
  });

  it("uses injectable random bytes and stays inside the deck", () => {
    expect(pickPhotoChallengeIndex(7, () => new Uint8Array([0, 0, 0, 9]))).toBe(2);
    expect(() => pickPhotoChallengeIndex(0)).toThrow(/non-empty/i);
  });
});
