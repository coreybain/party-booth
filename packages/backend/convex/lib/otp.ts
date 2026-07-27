import { generateOtpCode, OTP_POLICY, type OtpPurpose } from "@partybooth/contracts";
import type { EmailOTPOptions } from "better-auth/plugins/email-otp";

import { isAdminEmail } from "./config";

/**
 * The email-OTP policy, translated for Better Auth.
 *
 * PLAN.md fixes the numbers — six digits, ten-minute expiry, five attempts,
 * sixty-second resend cooldown — and `@partybooth/contracts` owns them so the
 * clients can display the same limits. This is the single place they cross into
 * provider configuration, which is why it is a separate, testable function
 * rather than an object literal buried in `auth.ts`.
 *
 * Better Auth expresses the resend cooldown as a rate limit on the
 * send-verification endpoint: one request per sixty-second window.
 */
export function emailOtpPolicyOptions(): Omit<EmailOTPOptions, "sendVerificationOTP"> {
  return {
    otpLength: OTP_POLICY.codeLength,
    expiresIn: Math.floor(OTP_POLICY.ttlMs / 1000),
    allowedAttempts: OTP_POLICY.maxAttempts,
    rateLimit: {
      window: Math.floor(OTP_POLICY.resendCooldownMs / 1000),
      max: 1,
    },
    // Never keep a usable code at rest: a database leak must not also be a
    // sign-in-as-anyone leak.
    storeOTP: "hashed",
    // Uniformly random, and free of the guessable shapes (`123456`, `000000`)
    // that a five-attempt budget would otherwise reward.
    generateOTP: () => generateOtpCode(),
  };
}

export type BetterAuthOtpType =
  "sign-in" | "email-verification" | "forget-password" | "change-email";

/**
 * Map Better Auth's OTP `type` onto our purpose, which decides the email copy
 * and the audit action.
 *
 * Admin sign-ins are told apart by the allowlist rather than by a separate
 * endpoint — there is one OTP pipeline, and `/admin` is a property of the
 * address, not of the route the code was requested from.
 */
export function otpPurposeFor(type: BetterAuthOtpType, email: string): OtpPurpose {
  if (type !== "sign-in") return "emailVerification";
  return isAdminEmail(email) ? "adminSignIn" : "organiserSignIn";
}
