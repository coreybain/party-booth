import { hasAcceptedTerms } from "@partybooth/contracts/terms";

interface GateUser {
  readonly onboardedAt?: number;
  readonly acceptedTermsVersion?: string;
}

export interface SessionGates {
  readonly needsOnboarding: boolean;
  /** An already-onboarded account must accept the currently published terms. */
  readonly needsTermsAcceptance: boolean;
}

/**
 * New accounts accept terms with their profile confirmation. Only established
 * accounts get the focused recovery screen, so the two prompts never stack.
 */
export function sessionGatesFor(user: GateUser | null): SessionGates {
  const needsOnboarding = user === null || user.onboardedAt === undefined;
  return {
    needsOnboarding,
    needsTermsAcceptance: !needsOnboarding && !hasAcceptedTerms(user),
  };
}
