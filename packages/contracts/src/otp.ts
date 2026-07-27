import { z } from "zod";

import { defaultRandomBytes, generateEventCode, type RandomBytes } from "./codes";

/**
 * Six-digit email OTP policy, as pure logic.
 *
 * PLAN.md fixes the numbers: **10-minute expiry, five attempts, 60-second
 * resend cooldown**, plus the per-address send ceiling that closes the
 * enumeration hole.
 *
 * Two halves, with a hard line between them:
 *
 * - **Verification** — expiry, the five-guess budget, single use, hashing at
 *   rest — is enforced by Better Auth's `emailOTP` plugin. The numbers below
 *   are handed to it in `packages/backend/convex/lib/otp.ts`. There is
 *   deliberately no second implementation here: a parallel `verifyOtp` with its
 *   own tests and no callers reads as a guarantee and is not one.
 * - **Sending** — the 60-second cooldown and the hourly ceiling — is enforced by
 *   *us*, in `packages/backend/convex/otp.ts`, because Better Auth's own rate
 *   limiter defaults to an in-memory store that Convex's recycled isolates do
 *   not share. {@link canSendOtp} and {@link registerOtpSend} are what that
 *   mutation calls.
 *
 * Nothing here touches a clock or a database: every function takes `now` and a
 * plain state object and returns the next state.
 */
export const OTP_POLICY = {
  /** Digits in the emailed code. */
  codeLength: 6,
  /** How long a code stays usable. Enforced by the `emailOTP` plugin. */
  ttlMs: 10 * 60 * 1000,
  /** Wrong guesses allowed before the code is burned. Enforced by the plugin. */
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

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What we persist per normalised email address, and nothing more.
 *
 * The code itself is **not** here on purpose: it lives wherever Better Auth
 * stores verification values, hashed. Neither are attempt counters — the plugin
 * owns those, and duplicating them here would mean two sources of truth for
 * whether a code is still usable.
 */
export interface OtpSendState {
  /** When a code was last emailed (drives the resend cooldown). */
  lastSentAt: number;
  /** Codes sent in the current send window (drives enumeration protection). */
  sendCount: number;
  /** Start of the current send window. */
  windowStartedAt: number;
}

export type OtpSendDenial = "cooldown" | "rateLimited";

export type OtpSendDecision =
  { allowed: true } | { allowed: false; reason: OtpSendDenial; retryAfterMs: number };

/** The state recorded for an address that has never been sent a code. */
export function createOtpSendState(now: number): OtpSendState {
  return { lastSentAt: now, sendCount: 1, windowStartedAt: now };
}

/**
 * May we send (or resend) a code right now?
 *
 * Two independent brakes: the 60-second cooldown between consecutive sends, and
 * the per-window ceiling. The caller should surface `retryAfterMs` to the user
 * but must **not** vary the response by whether the address exists — that is
 * the enumeration hole this whole policy exists to close.
 */
export function canSendOtp(state: OtpSendState | undefined, now: number): OtpSendDecision {
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
 * The state after a code has been emailed. The send ceiling keeps counting
 * across the whole window — that, not the cooldown, is the real brake on abuse.
 */
export function registerOtpSend(state: OtpSendState | undefined, now: number): OtpSendState {
  if (state === undefined) return createOtpSendState(now);

  const windowIsCurrent = now - state.windowStartedAt < OTP_POLICY.sendWindowMs;

  return {
    lastSentAt: now,
    sendCount: windowIsCurrent ? state.sendCount + 1 : 1,
    windowStartedAt: windowIsCurrent ? state.windowStartedAt : now,
  };
}

/**
 * User-facing copy for a refused send. Deliberately identical whether or not
 * the address has ever been seen before — the decision depends only on send
 * history for that address, which is all an attacker already controls.
 */
export const OTP_SEND_DENIAL_MESSAGES: Record<OtpSendDenial, string> = {
  cooldown: "Wait a moment before asking for another code.",
  rateLimited: "Too many codes requested for that address. Try again later.",
};

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/** Generate a code to email. Server-side only — see `codes.ts`. */
export function generateOtpCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  return generateEventCode(randomBytes);
}
