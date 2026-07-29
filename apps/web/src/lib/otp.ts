/**
 * Client-side helpers for the six-digit code inputs (organiser OTP, admin OTP,
 * event join code).
 *
 * These are presentation-layer conveniences only: they make the form feel right
 * on a phone (numeric keypad, paste-a-code-from-Mail, no accidental spaces).
 * They are **not** a security boundary — every check is repeated on the server.
 */

import { isValidEventCode, JOIN_CODE_LENGTH, OTP_LENGTH } from "./contracts";

/** Lower-case and trim. Mail clients love to send back "  Corey@Example.COM ". */
export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Good enough to disable the submit button before a round trip. Intentionally
 * permissive — the authoritative check is Resend actually delivering the mail.
 */
export function isProbablyEmail(input: string): boolean {
  const value = normaliseEmail(input);
  if (value.length < 6 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/**
 * Keep digits only and clamp to `length`. Handles the two ways people enter a
 * code on a phone: typing it, or pasting "Your code is 482 913" from Mail.
 */
export function normaliseDigits(raw: string, length: number): string {
  return raw.replace(/\D/g, "").slice(0, length);
}

/** Normalise a six-digit OTP as the user types. */
export function normaliseOtp(raw: string): string {
  return normaliseDigits(raw, OTP_LENGTH);
}

/** Normalise a six-digit event join code as the user types. */
export function normaliseJoinCode(raw: string): string {
  return normaliseDigits(raw, JOIN_CODE_LENGTH);
}

/** True once the field holds a full six-digit code. */
export function isCompleteOtp(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(value);
}

/**
 * True once the field holds a full event join code. Delegates to
 * `@partybooth/contracts` so the button never enables on something the backend
 * would reject.
 */
export function isCompleteJoinCode(value: string): boolean {
  return isValidEventCode(value);
}

/** "Resend in 0:45" — seconds are clamped at zero so the label never goes negative. */
export function formatCooldown(secondsRemaining: number): string {
  const total = Math.max(0, Math.ceil(secondsRemaining));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Turn whatever Better Auth (or a network failure) hands back into one sentence
 * a guest at a party can act on.
 *
 * Better Auth returns `{ data, error }` where `error` is
 * `{ code?, message?, status? }`. Codes are matched case-insensitively because
 * plugin error codes are not stable across versions.
 */
export function authErrorMessage(error: unknown): string {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record["code"] === "string" ? record["code"].toUpperCase() : "";
  const message = typeof record["message"] === "string" ? record["message"] : "";
  const status = typeof record["status"] === "number" ? record["status"] : 0;

  if (code.includes("TOO_MANY") || code.includes("RATE") || status === 429) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (code.includes("EXPIRED")) {
    return "That code has expired. Ask for a new one.";
  }
  if (code.includes("ORIGIN")) {
    return "This sign-in page is not allowed by the backend configuration. Check SITE_URL and try again.";
  }
  if (code.includes("INVALID") || code.includes("OTP") || status === 401 || status === 400) {
    return "That code was not right. Check the digits and try again.";
  }
  if (message.length > 0) return message;
  return "Something went wrong. Try again in a moment.";
}
