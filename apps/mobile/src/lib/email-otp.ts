/**
 * Presentation and transport helpers for six-digit email codes.
 *
 * Better Auth owns verification, expiry and the attempt budget. These helpers keep
 * the two mobile forms (reviewer sign-in and secondary-email verification) aligned
 * with the shared contract while leaving the server as the authority.
 */

import { emailSchema } from "@partybooth/contracts/schemas";
import { OTP_POLICY, otpCodeSchema } from "@partybooth/contracts/otp";

export interface EmailInput {
  readonly value: string;
  readonly valid: boolean;
  readonly error?: string;
}

export interface OtpInput {
  readonly digits: string;
  readonly complete: boolean;
  readonly error?: string;
}

/** Normalise an address exactly as the backend contract does. */
export function readEmailInput(raw: string, touched = false): EmailInput {
  const parsed = emailSchema.safeParse(raw);
  if (parsed.success) return { value: parsed.data, valid: true };

  return {
    value: raw.trim().toLowerCase(),
    valid: false,
    ...(touched
      ? { error: parsed.error.issues[0]?.message ?? "Enter a valid email address." }
      : {}),
  };
}

/** Digits only, capped at the shared policy length, with paste-friendly input. */
export function readOtpInput(raw: string, touched = false): OtpInput {
  const digits = raw.replace(/\D/g, "").slice(0, OTP_POLICY.codeLength);
  const parsed = otpCodeSchema.safeParse(digits);
  return {
    digits,
    complete: parsed.success,
    ...(!parsed.success && touched
      ? { error: parsed.error.issues[0]?.message ?? "Enter the six-digit code." }
      : {}),
  };
}

/** `0:45`, clamped so a timer never renders a negative value. */
export function formatOtpCooldown(secondsRemaining: number): string {
  const total = Math.max(0, Math.ceil(secondsRemaining));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

export interface EmailOtpClient {
  readonly emailOtp: {
    readonly sendVerificationOtp: (input: {
      email: string;
      type: "sign-in";
    }) => Promise<{ error?: unknown } | { error: unknown } | undefined>;
  };
  readonly signIn: {
    readonly emailOtp: (input: {
      email: string;
      otp: string;
    }) => Promise<{ error?: unknown } | { error: unknown } | undefined>;
  };
}

export type EmailOtpOutcome =
  { readonly status: "ok" } | { readonly status: "error"; readonly message: string };

/** Safe copy for Better Auth's structured errors and ordinary network failures. */
export function emailOtpErrorMessage(error: unknown): string {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record["code"] === "string" ? record["code"].toUpperCase() : "";
  const message = typeof record["message"] === "string" ? record["message"] : "";
  const status = typeof record["status"] === "number" ? record["status"] : 0;

  if (code.includes("TOO_MANY") || code.includes("RATE") || status === 429) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (code.includes("EXPIRED")) return "That code has expired. Ask for a new one.";
  if (code.includes("ORIGIN")) {
    return "This build is not allowed by the sign-in service. Check the app configuration and try again.";
  }
  if (code.includes("INVALID") || code.includes("OTP") || status === 400 || status === 401) {
    return "That code was not right. Check the digits and try again.";
  }
  if (message.length > 0) return message;
  return "Something went wrong. Check your connection and try again.";
}

/** Request the Better Auth sign-in challenge. The demo account uses this same path. */
export async function sendEmailSignInCode(
  client: EmailOtpClient,
  email: string,
): Promise<EmailOtpOutcome> {
  try {
    const result = await client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    if (result?.error) return { status: "error", message: emailOtpErrorMessage(result.error) };
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: emailOtpErrorMessage(error) };
  }
}

/** Verify a sign-in code through Better Auth; no mobile-only bypass exists. */
export async function signInWithEmailCode(
  client: EmailOtpClient,
  email: string,
  otp: string,
): Promise<EmailOtpOutcome> {
  try {
    const result = await client.signIn.emailOtp({ email, otp });
    if (result?.error) return { status: "error", message: emailOtpErrorMessage(result.error) };
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: emailOtpErrorMessage(error) };
  }
}
