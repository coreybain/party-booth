import { TERMS_VERSION } from "@partybooth/contracts/terms";
import { describe, expect, it } from "vitest";

import { sessionGatesFor } from "./session-gates";

describe("session gates", () => {
  it("keeps new accounts in profile onboarding, where terms are accepted too", () => {
    expect(sessionGatesFor(null)).toEqual({
      needsOnboarding: true,
      needsTermsAcceptance: false,
    });
    expect(sessionGatesFor({ acceptedTermsVersion: TERMS_VERSION })).toEqual({
      needsOnboarding: true,
      needsTermsAcceptance: false,
    });
  });

  it("asks established accounts to accept missing or stale terms", () => {
    expect(sessionGatesFor({ onboardedAt: 1 })).toEqual({
      needsOnboarding: false,
      needsTermsAcceptance: true,
    });
    expect(sessionGatesFor({ onboardedAt: 1, acceptedTermsVersion: "old" })).toEqual({
      needsOnboarding: false,
      needsTermsAcceptance: true,
    });
  });

  it("lets an established account through after accepting the current version", () => {
    expect(sessionGatesFor({ onboardedAt: 1, acceptedTermsVersion: TERMS_VERSION })).toEqual({
      needsOnboarding: false,
      needsTermsAcceptance: false,
    });
  });
});
