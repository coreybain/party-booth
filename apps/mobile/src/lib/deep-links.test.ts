import { describe, expect, it } from "vitest";

import { buildJoinUrl, isJoinToken, normaliseJoinCode, parseJoinLink } from "./deep-links";

/**
 * A real invite token: 32 Crockford base32 characters, the format
 * `@partybooth/contracts/codes` generates and Convex stores.
 */
const TOKEN = "7KD2QP9RX4TV1WM8ZB3NC6HS5JAEFGTV";

describe("normaliseJoinCode", () => {
  it("accepts a plain six-digit code", () => {
    expect(normaliseJoinCode("428913")).toBe("428913");
  });

  it("strips the separators people type off a printed sign", () => {
    expect(normaliseJoinCode("428 913")).toBe("428913");
    expect(normaliseJoinCode("428-913")).toBe("428913");
    expect(normaliseJoinCode(" 4 2 8 9 1 3 ")).toBe("428913");
  });

  it("rejects anything that is not exactly six digits", () => {
    expect(normaliseJoinCode("42891")).toBeNull();
    expect(normaliseJoinCode("4289133")).toBeNull();
    expect(normaliseJoinCode("")).toBeNull();
    expect(normaliseJoinCode("abcdef")).toBeNull();
  });
});

describe("isJoinToken", () => {
  it("accepts a canonical Crockford invite token", () => {
    expect(isJoinToken(TOKEN)).toBe(true);
  });

  it("folds the transcription errors Crockford is designed to tolerate", () => {
    // Lower case, hyphen grouping as printed on signage, and the I/L/O family.
    expect(isJoinToken(TOKEN.toLowerCase())).toBe(true);
    expect(isJoinToken(`${TOKEN.slice(0, 16)}-${TOKEN.slice(16)}`)).toBe(true);
    expect(isJoinToken(TOKEN.replace("1", "I").replace("0", "O"))).toBe(true);
  });

  it("rejects tokens of the wrong length or alphabet", () => {
    expect(isJoinToken("short")).toBe(false);
    expect(isJoinToken("X".repeat(31))).toBe(false);
    expect(isJoinToken("X".repeat(33))).toBe(false);
    expect(isJoinToken(`${"X".repeat(26)}/../etc`)).toBe(false);
    // `_` and `-` were accepted by the old loose pattern; Crockford has neither.
    expect(isJoinToken(`${"X".repeat(31)}_`)).toBe(false);
  });
});

describe("parseJoinLink", () => {
  it("parses the printed-QR universal link", () => {
    expect(parseJoinLink(`https://partybooth.app/join/${TOKEN}`)).toEqual({
      kind: "token",
      token: TOKEN,
    });
  });

  it("parses the custom scheme, where the segment lands in the host position", () => {
    expect(parseJoinLink(`partybooth://join/${TOKEN}`)).toEqual({ kind: "token", token: TOKEN });
  });

  it("is case-insensitive about the scheme and the join segment", () => {
    expect(parseJoinLink(`PartyBooth://Join/${TOKEN}`)).toEqual({ kind: "token", token: TOKEN });
    expect(parseJoinLink(`https://partybooth.app/JOIN/${TOKEN}`)).toEqual({
      kind: "token",
      token: TOKEN,
    });
  });

  it("reads a token from the query string when there is no path segment", () => {
    expect(parseJoinLink(`https://partybooth.app/join?token=${TOKEN}`)).toEqual({
      kind: "token",
      token: TOKEN,
    });
  });

  it("recognises a six-digit code shared as a link", () => {
    expect(parseJoinLink("https://partybooth.app/join/428913")).toEqual({
      kind: "code",
      code: "428913",
    });
    expect(parseJoinLink("https://partybooth.app/join?code=428913")).toEqual({
      kind: "code",
      code: "428913",
    });
  });

  it("does not mistake the digits inside a token for a join code", () => {
    // The regression this guards: leniently stripping non-digits from `A4B2C8…`
    // leaves six digits and would classify a token as a code.
    const digitHeavy = "A4B2C8D9E1F3G5H7J2K4M6N8P0Q1R3S5";
    expect(parseJoinLink(`https://partybooth.app/join/${digitHeavy}`)).toEqual({
      kind: "token",
      token: digitHeavy,
    });
  });

  it("normalises a token before handing it on", () => {
    // Whatever the QR or the typed link contained, the app sends the canonical
    // Crockford form — the only thing the join mutation will match against.
    expect(parseJoinLink(`https://partybooth.app/join/${TOKEN.toLowerCase()}`)).toEqual({
      kind: "token",
      token: TOKEN,
    });
  });

  it("handles percent-encoded segments", () => {
    expect(parseJoinLink(`https://partybooth.app/join/${encodeURIComponent(TOKEN)}`)).toEqual({
      kind: "token",
      token: TOKEN,
    });
  });

  it("ignores links that are not joins", () => {
    // OAuth callbacks and the launcher's own open both arrive as deep links and must
    // not be treated as invites.
    expect(parseJoinLink("partybooth://")).toBeNull();
    expect(parseJoinLink("partybooth:///?code=abc&state=xyz")).toBeNull();
    expect(parseJoinLink("https://partybooth.app/privacy")).toBeNull();
    expect(parseJoinLink("https://partybooth.app/")).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    expect(parseJoinLink("")).toBeNull();
    expect(parseJoinLink("not a url")).toBeNull();
    expect(parseJoinLink("mailto:someone@example.com")).toBeNull();
    expect(parseJoinLink("https://partybooth.app/join/!!!")).toBeNull();
  });
});

/**
 * `app/join/[token].tsx` does not get a URL — Expo Router has already taken the link
 * apart and handed it one path segment. It puts that segment back into a synthetic
 * URL so there is exactly one classifier in the app. These pin that wrapping, because
 * a route parameter is the one input that never goes through `parseJoinLink` naturally.
 */
function parseRouteParam(segment: string) {
  return parseJoinLink(`https://join.invalid/join/${encodeURIComponent(segment)}`);
}

describe("join route parameter", () => {
  it("classifies a token handed over by the router", () => {
    expect(parseRouteParam(TOKEN)).toEqual({ kind: "token", token: TOKEN });
  });

  it("classifies a six-digit code, so a parked code can reuse the same route", () => {
    expect(parseRouteParam("428913")).toEqual({ kind: "code", code: "428913" });
  });

  it("normalises a token transcribed off signage in lower case", () => {
    expect(parseRouteParam(TOKEN.toLowerCase())).toEqual({ kind: "token", token: TOKEN });
  });

  it("survives a segment that would break URL parsing if it were not encoded", () => {
    // A malformed invite must produce "that didn't work", never a thrown TypeError on
    // the first screen a scanned QR opens.
    expect(parseRouteParam("../../etc/passwd")).toBeNull();
    expect(parseRouteParam("a b?c#d")).toBeNull();
    expect(parseRouteParam("")).toBeNull();
  });
});

describe("buildJoinUrl", () => {
  it("builds the canonical link that goes on the QR", () => {
    expect(buildJoinUrl("https://partybooth.app", TOKEN)).toBe(
      `https://partybooth.app/join/${TOKEN}`,
    );
  });

  it("ignores any path on the site URL so the link is always absolute", () => {
    expect(buildJoinUrl("https://partybooth.app/some/path", TOKEN)).toBe(
      `https://partybooth.app/join/${TOKEN}`,
    );
  });

  it("round-trips through the parser", () => {
    const url = buildJoinUrl("https://partybooth.app", TOKEN);
    expect(parseJoinLink(url)).toEqual({ kind: "token", token: TOKEN });
  });
});
