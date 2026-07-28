import { displayNameSchema } from "@partybooth/contracts/schemas";
import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_MAX_LENGTH,
  EMPTY_LOCAL_PROFILE,
  initialFor,
  localProfileKey,
  parseLocalProfile,
  readDisplayName,
  serialiseLocalProfile,
} from "./profile";

describe("readDisplayName", () => {
  it("trims, because a trailing space is not a different name", () => {
    expect(readDisplayName("  Sam  ")).toEqual({ value: "Sam", valid: true, error: null });
  });

  it("stays quiet on an empty field until it has been touched", () => {
    // A red "Enter a name." before the guest has typed anything reads as an accusation.
    expect(readDisplayName("", false).error).toBeNull();
    expect(readDisplayName("", true).error).not.toBeNull();
    expect(readDisplayName("", true).valid).toBe(false);
  });

  it("treats whitespace-only as empty", () => {
    expect(readDisplayName("   ", true).valid).toBe(false);
  });

  it("agrees with the contract about the ceiling", () => {
    // The field's `maxLength` and the schema the backend parses with have to be the
    // same number, or a name is accepted by the keyboard and refused by the server.
    const atLimit = "a".repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(readDisplayName(atLimit).valid).toBe(true);
    expect(displayNameSchema.safeParse(atLimit).success).toBe(true);

    const overLimit = "a".repeat(DISPLAY_NAME_MAX_LENGTH + 1);
    expect(readDisplayName(overLimit, true).valid).toBe(false);
    expect(displayNameSchema.safeParse(overLimit).success).toBe(false);
  });

  it("surfaces the contract's own message rather than inventing one", () => {
    const overLimit = "a".repeat(DISPLAY_NAME_MAX_LENGTH + 1);
    const parsed = displayNameSchema.safeParse(overLimit);
    expect(readDisplayName(overLimit, true).error).toBe(parsed.error?.issues[0]?.message);
  });
});

describe("initialFor", () => {
  it("uses the first visible character, upper-cased", () => {
    expect(initialFor("sam")).toBe("S");
    expect(initialFor("  ada ")).toBe("A");
  });

  it("degrades to a placeholder rather than an empty circle", () => {
    expect(initialFor("")).toBe("?");
    expect(initialFor("   ")).toBe("?");
  });
});

describe("localProfileKey", () => {
  it("is scoped per account, so two people sharing a phone do not share an avatar", () => {
    expect(localProfileKey("user_a")).not.toBe(localProfileKey("user_b"));
  });

  it("only ever emits characters the secure store accepts", () => {
    expect(localProfileKey("a/b c:d")).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("local profile serialisation", () => {
  it("round-trips", () => {
    const profile = { photoUri: "file:///tmp/a.jpg" };
    expect(parseLocalProfile(serialiseLocalProfile(profile))).toEqual(profile);
  });

  it("survives anything a previous version or a corrupt keychain might hold", () => {
    // Losing a remembered avatar is acceptable; a crash loop on the first screen
    // after sign-in is not.
    for (const bad of [null, undefined, "", "not json", "[]", '"a string"', "123"]) {
      expect(parseLocalProfile(bad)).toEqual(EMPTY_LOCAL_PROFILE);
    }
  });

  it("drops fields of the wrong type instead of trusting them", () => {
    expect(parseLocalProfile('{"photoUri":42}')).toEqual(EMPTY_LOCAL_PROFILE);
  });

  it("drops the retired confirmation flag rather than migrating it", () => {
    // "Has this guest confirmed a name?" is `users.onboardedAt` now, so a record
    // written by an older build must not smuggle a second answer back in.
    expect(parseLocalProfile('{"photoUri":"file:///a.jpg","confirmedAt":1700000000000}')).toEqual({
      photoUri: "file:///a.jpg",
    });
  });
});
