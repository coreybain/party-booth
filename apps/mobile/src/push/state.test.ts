import { describe, expect, it } from "vitest";

import { EMPTY_PUSH_STATE, isArmed, parsePushState, serialisePushState } from "./state";

describe("parsePushState", () => {
  it("round-trips what it wrote", () => {
    const state = { armedAt: 1_700_000_000_000, promptedAt: 1_700_000_100_000, token: "tok" };
    expect(parsePushState(serialisePushState(state))).toEqual(state);
  });

  it("omits absent fields rather than writing nulls", () => {
    // `null` would come back as a value and defeat the `=== undefined` checks
    // the provider branches on.
    expect(serialisePushState({ token: "tok" })).toBe('{"token":"tok"}');
  });

  it.each([
    ["a missing file", null],
    ["an empty file", ""],
    ["a half-written file", '{"armedAt":'],
    ["an array", "[]"],
    ["a bare number", "7"],
  ])("starts from nothing given %s", (_name, raw) => {
    expect(parsePushState(raw)).toEqual(EMPTY_PUSH_STATE);
  });

  it("drops a field of the wrong shape instead of trusting it", () => {
    expect(parsePushState('{"armedAt":"yesterday","token":42}')).toEqual({
      armedAt: undefined,
      promptedAt: undefined,
      token: undefined,
    });
  });
});

describe("isArmed", () => {
  it("is false until a join has happened", () => {
    expect(isArmed(EMPTY_PUSH_STATE)).toBe(false);
    expect(isArmed({ armedAt: 1 })).toBe(true);
  });
});
