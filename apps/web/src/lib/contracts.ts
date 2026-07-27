/**
 * The single seam between `apps/web` and `@partybooth/contracts`.
 *
 * Every shared constant, type and rule the web app uses is re-exported from
 * here, so there is exactly one file to look at when the contracts package
 * moves. Nothing else in `apps/web` imports `@partybooth/contracts` directly.
 *
 * The derived constants below exist because the contracts package speaks in
 * milliseconds (right for a state machine that takes `now`) while the UI speaks
 * in minutes and seconds. Deriving them here means the copy on screen can never
 * drift from the policy the backend enforces.
 */

export { ROLES, type Role, type EventRole, isHostRole } from "@partybooth/contracts/roles";

export {
  EVENT_CODE_LENGTH,
  isValidEventCode,
  isValidInviteToken,
  normalizeEventCode,
} from "@partybooth/contracts/codes";

import { EVENT_CODE_LENGTH } from "@partybooth/contracts/codes";
import { OTP_POLICY } from "@partybooth/contracts/otp";

export { OTP_POLICY };

/**
 * Digits in the emailed code.
 *
 * Widened to `number` on purpose: `OTP_POLICY` is `as const`, so the literal
 * types would leak into component state (`useState(5)` infers `5`) and make
 * ordinary arithmetic a type error.
 */
export const OTP_LENGTH: number = OTP_POLICY.codeLength;

/** "Expires in 10 minutes." */
export const OTP_EXPIRY_MINUTES: number = Math.round(OTP_POLICY.ttlMs / 60_000);

/** Wrong guesses allowed before the challenge is burned. */
export const OTP_MAX_ATTEMPTS: number = OTP_POLICY.maxAttempts;

/** Seconds the "Resend code" button stays locked. */
export const OTP_RESEND_COOLDOWN_SECONDS: number = Math.round(OTP_POLICY.resendCooldownMs / 1_000);

/** Digits in the printed event join code. Same six digits as the OTP, different thing. */
export const JOIN_CODE_LENGTH: number = EVENT_CODE_LENGTH;
