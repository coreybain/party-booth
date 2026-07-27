import { z } from "zod";

import {
  constantTimeEqual,
  defaultRandomBytes,
  generateEventCode,
  type RandomBytes,
} from "./codes";

/**
 * Six-digit email OTP policy, as pure logic.
 *
 * PLAN.md fixes the numbers: **10-minute expiry, five attempts, 60-second
 * resend cooldown**. They live here rather than inside the Better Auth
 * configuration so that the web organiser login, the `/admin` login, the guest
 * web login and the App Review demo login all enforce one policy, and so the
 * policy is testable without a deployment.
 *
 * Nothing here touches a clock or a database: every function takes `now` and a
 * plain state object and returns the next state. The Convex layer is
 * responsible for persisting it.
 */
export const OTP_POLICY = {
  /** Digits in the emailed code. */
  codeLength: 6,
  /** How long a code stays usable. */
  ttlMs: 10 * 60 * 1000,
  /** Wrong guesses allowed before the challenge is burned. */
  maxAttempts: 5,
  /** Minimum gap between "send me another code" requests. */
  resendCooldownMs: 60 * 1000,
  /**
   * Enumeration protection: a hard ceiling on codes sent for one address per
   * window, independent of the cooldown. Stops a slow drip of sends being used
   * to test whether an address exists — or to mailbomb someone.
   */
  maxSendsPerWindow: 5,
  sendWindowMs: 60 * 60 * 1000,
} as const;

export const otpCodeSchema = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine((value) => /^\d{6}$/.test(value), { error: "Enter the six-digit code we emailed you." });

/** Reason an OTP challenge may be issued. Drives the email template and audit. */
export const OTP_PURPOSES = [
  "organiserSignIn",
  "guestSignIn",
  "adminSignIn",
  "emailVerification",
] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const otpPurposeSchema = z.enum(OTP_PURPOSES);

/**
 * The persisted half of a challenge. The code itself is **not** here on
 * purpose: it lives wherever Better Auth stores verification values, and
 * {@link verifyOtp} takes the expected value as an argument so this module
 * never has an opinion about hashing.
 */
export interface OtpChallengeState {
  /** When the current code was created. */
  issuedAt: number;
  /** When the current code stops working. */
  expiresAt: number;
  /** Failed verification attempts against the current code. */
  attempts: number;
  /** When a code was last emailed (drives the resend cooldown). */
  lastSentAt: number;
  /** Codes sent in the current send window (drives enumeration protection). */
  sendCount: number;
  /** Set once the code has been redeemed; a code is strictly single-use. */
  consumedAt?: number | undefined;
  /** Start of the current send window. */
  windowStartedAt: number;
}

export function otpExpiresAt(issuedAt: number): number {
  return issuedAt + OTP_POLICY.ttlMs;
}

/** A brand-new challenge for an address that has none. */
export function createOtpChallenge(now: number): OtpChallengeState {
  return {
    issuedAt: now,
    expiresAt: otpExpiresAt(now),
    attempts: 0,
    lastSentAt: now,
    sendCount: 1,
    windowStartedAt: now,
    consumedAt: undefined,
  };
}

export function isOtpExpired(state: OtpChallengeState, now: number): boolean {
  return now >= state.expiresAt;
}

export function isOtpConsumed(state: OtpChallengeState): boolean {
  return state.consumedAt !== undefined;
}

export function isOtpLockedOut(state: OtpChallengeState): boolean {
  return state.attempts >= OTP_POLICY.maxAttempts;
}

export function otpAttemptsRemaining(state: OtpChallengeState): number {
  return Math.max(0, OTP_POLICY.maxAttempts - state.attempts);
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

export type OtpSendDenial = "cooldown" | "rateLimited";

export type OtpSendDecision =
  { allowed: true } | { allowed: false; reason: OtpSendDenial; retryAfterMs: number };

/**
 * May we send (or resend) a code right now?
 *
 * Two independent brakes: the 60-second cooldown between consecutive sends, and
 * the per-window ceiling. The caller should surface `retryAfterMs` to the user
 * but must **not** vary the response by whether the address exists — that is
 * the enumeration hole this whole policy exists to close.
 */
export function canSendOtp(state: OtpChallengeState | undefined, now: number): OtpSendDecision {
  if (state === undefined) return { allowed: true };

  const windowElapsed = now - state.windowStartedAt;
  const windowIsCurrent = windowElapsed < OTP_POLICY.sendWindowMs;

  if (windowIsCurrent && state.sendCount >= OTP_POLICY.maxSendsPerWindow) {
    return {
      allowed: false,
      reason: "rateLimited",
      retryAfterMs: OTP_POLICY.sendWindowMs - windowElapsed,
    };
  }

  const sinceLastSend = now - state.lastSentAt;
  if (sinceLastSend < OTP_POLICY.resendCooldownMs) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterMs: OTP_POLICY.resendCooldownMs - sinceLastSend,
    };
  }

  return { allowed: true };
}

/**
 * The state after a code has been emailed. Resetting `attempts` is deliberate:
 * a new code is a new secret, so the five guesses apply to it, while the send
 * ceiling (which is the real brake on abuse) keeps counting.
 */
export function registerOtpSend(
  state: OtpChallengeState | undefined,
  now: number,
): OtpChallengeState {
  if (state === undefined) return createOtpChallenge(now);

  const windowIsCurrent = now - state.windowStartedAt < OTP_POLICY.sendWindowMs;

  return {
    issuedAt: now,
    expiresAt: otpExpiresAt(now),
    attempts: 0,
    lastSentAt: now,
    sendCount: windowIsCurrent ? state.sendCount + 1 : 1,
    windowStartedAt: windowIsCurrent ? state.windowStartedAt : now,
    consumedAt: undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Verifying                                                                  */
/* -------------------------------------------------------------------------- */

export type OtpFailureReason = "notFound" | "consumed" | "expired" | "lockedOut" | "mismatch";

export type OtpVerification =
  | { ok: true; state: OtpChallengeState }
  | {
      ok: false;
      reason: OtpFailureReason;
      state: OtpChallengeState | undefined;
      attemptsRemaining: number;
    };

/**
 * Check a submitted code against the expected one and return the next state.
 *
 * `expected` may be the raw code or a hash, as long as `submitted` has been put
 * through the same transform — the comparison is constant-time either way.
 *
 * Order matters: consumed → expired → locked out → mismatch. A malformed
 * submission is treated as a mismatch and **burns an attempt**, so garbage
 * input cannot be used to probe for free.
 */
export function verifyOtp(
  state: OtpChallengeState | undefined,
  submitted: string,
  expected: string,
  now: number,
): OtpVerification {
  if (state === undefined) {
    return { ok: false, reason: "notFound", state: undefined, attemptsRemaining: 0 };
  }
  if (isOtpConsumed(state)) {
    return { ok: false, reason: "consumed", state, attemptsRemaining: 0 };
  }
  if (isOtpExpired(state, now)) {
    return { ok: false, reason: "expired", state, attemptsRemaining: 0 };
  }
  if (isOtpLockedOut(state)) {
    return { ok: false, reason: "lockedOut", state, attemptsRemaining: 0 };
  }

  if (constantTimeEqual(submitted, expected)) {
    return { ok: true, state: { ...state, consumedAt: now } };
  }

  const next: OtpChallengeState = { ...state, attempts: state.attempts + 1 };
  return {
    ok: false,
    reason: isOtpLockedOut(next) ? "lockedOut" : "mismatch",
    state: next,
    attemptsRemaining: otpAttemptsRemaining(next),
  };
}

/**
 * User-facing copy. Every failure except `cooldown`/`rateLimited` is
 * deliberately vague about *which* thing went wrong on the sign-in screen; the
 * distinctions matter for the audit log, not for the person typing.
 */
export const OTP_FAILURE_MESSAGES: Record<OtpFailureReason, string> = {
  notFound: "That code has expired. Request a new one.",
  consumed: "That code has already been used. Request a new one.",
  expired: "That code has expired. Request a new one.",
  lockedOut: "Too many incorrect codes. Request a new one.",
  mismatch: "That code is not right.",
};

/** Generate a code to email. Server-side only — see `codes.ts`. */
export function generateOtpCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  return generateEventCode(randomBytes);
}
