import { describe, expect, it } from "vitest";

import { joinFallbackUrl, joinUrl } from "./join-url";

/**
 * What is left to test here is the *origin*, not the link.
 *
 * The shape of `/join/<token>` belongs to `@partybooth/contracts/codes` and is
 * tested there against the app's universal-link claim and the printed signage.
 * This file covers the one thing that is genuinely local: an origin is optional,
 * and the absence of one has to produce `undefined` rather than a relative URL a
 * camera cannot use. `origin` is passed explicitly so the tests do not depend on
 * `NEXT_PUBLIC_SITE_URL`, which is deliberately unset offline.
 */

const TOKEN = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const ORIGIN = "https://partybooth.example";

describe("joinUrl", () => {
  it("is absolute, so it can go in a QR code", () => {
    expect(joinUrl(TOKEN, ORIGIN)).toBe(`${ORIGIN}/join/${TOKEN}`);
  });

  it("never doubles the slash when the origin has a trailing one", () => {
    expect(joinUrl(TOKEN, "https://partybooth.example/")).toBe(`${ORIGIN}/join/${TOKEN}`);
  });

  it("returns undefined with no origin, rather than a relative URL a camera cannot use", () => {
    expect(joinUrl(TOKEN, undefined)).toBeUndefined();
  });
});

describe("joinFallbackUrl", () => {
  it("is the one URL that is safe to print in full — it carries no credential", () => {
    expect(joinFallbackUrl(ORIGIN)).toBe(`${ORIGIN}/join`);
    expect(joinFallbackUrl(ORIGIN)).not.toContain(TOKEN);
  });

  it("returns undefined with no origin", () => {
    expect(joinFallbackUrl(undefined)).toBeUndefined();
  });
});
