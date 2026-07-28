import { generateOtpCode, OTP_POLICY, type OtpPurpose } from "@partybooth/contracts";
import type { EmailOTPOptions } from "better-auth/plugins/email-otp";

import { demoLogin, isAdminEmail, isDemoAddress } from "./config";

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
    // that a five-attempt budget would otherwise reward — except for the one
    // address App Review is given, which gets the fixed code and only when the
    // deployment has opted in. See {@link demoOtpFor}.
    generateOTP: ({ email }) => demoOtpFor(email) ?? generateOtpCode(),
  };
}

/**
 * The fixed code for the reviewer's address, or `undefined` for everybody else.
 *
 * This is the **entire** demo-login mechanism, and its smallness is the point.
 * It does not bypass Better Auth's OTP flow — it is a parameter to it. The code
 * is still written to the `verification` table, still stored hashed, still
 * expires in ten minutes, still burns one of five attempts on a wrong guess, and
 * is still verified by the same endpoint every organiser uses. Nothing anywhere
 * compares a submitted code against an environment variable, so there is no
 * "demo path" to accidentally leave reachable: switch the variables off and this
 * function returns `undefined`, which is what it already returns for every
 * address that is not the reviewer's.
 *
 * The alternative — a branch in the verify path that accepts a magic code — was
 * rejected for exactly that reason. A second way to be signed in is a second
 * thing to get wrong.
 */
export function demoOtpFor(email: string): string | undefined {
  if (!isDemoAddress(email)) return undefined;
  return demoLogin()?.code;
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
