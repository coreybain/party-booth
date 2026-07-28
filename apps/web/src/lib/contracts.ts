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
  displayUrl,
  EVENT_CODE_LENGTH,
  INVITE_TOKEN_LENGTH,
  inviteUrl,
  isValidEventCode,
  isValidInviteToken,
  JOIN_FALLBACK_PATH,
  joinFallbackUrl,
  joinPath,
  normalizeEventCode,
  normalizeInviteToken,
} from "@partybooth/contracts/codes";

/**
 * The QR encoder. Pure, and shared with `apps/mobile`'s host tab, so the symbol
 * on the laptop and the symbol on the phone are the same bits — see
 * `packages/contracts/src/qr.ts`. Rendering stays local: this app draws inline
 * SVG (`src/components/qr-code.tsx`).
 */
export {
  byteCapacity,
  encodeQr,
  QR_QUIET_ZONE,
  QrCapacityError,
  qrPath,
  qrViewBoxSize,
  type QrMatrix,
} from "@partybooth/contracts/qr";

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export {
  acceptsUploads,
  EVENT_STATES,
  eventStateMachine,
  HOST_SETTABLE_EVENT_STATES,
  isEditableEventState,
  isJoinableEventState,
  isViewableEventState,
  JOIN_WINDOW,
  joinWindowStatus,
  LAUNCH_MODERATION_MODES,
  type EventState,
  type HostSettableEventState,
  type LaunchModerationMode,
  type ModerationMode,
} from "@partybooth/contracts/events";

export {
  captureIdSchema,
  checksumSchema,
  createEventInputSchema,
  displayNameSchema,
  eventNameSchema,
  eventScheduleSchema,
  hexColorSchema,
  timeZoneSchema,
  updateEventInputSchema,
} from "@partybooth/contracts/schemas";

/* -------------------------------------------------------------------------- */
/* Media and capture                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The capture lifecycle is the *client's* queue vocabulary, and it is shared
 * with `apps/mobile` on purpose — `captured → queued → uploading → uploaded`
 * describes a photo on a phone whether the phone is running Safari or Expo.
 * `src/lib/upload/machine.ts` validates every move against
 * `captureStateMachine` rather than writing its own `switch`, so a lifecycle
 * change lands in one file for both clients.
 */
export {
  allowedMimeTypes,
  CAPTURE_STATES,
  captureStateMachine,
  canSeeMedia,
  isCaptureInFlight,
  isTerminalCapture,
  MEDIA_LIMITS,
  MEDIA_SOURCES,
  MEDIA_STATES,
  MEDIA_TYPES,
  maxBytesFor,
  mediaSourceOf,
  mediaStateSchema,
  mediaTypeSchema,
  validateMediaFile,
  type CaptureState,
  type MediaSource,
  type MediaState,
  type MediaType,
} from "@partybooth/contracts/media";

/* -------------------------------------------------------------------------- */
/* Uploading                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `checkGrantEligibility` is run **client-side before asking for a grant** as
 * well as inside the Convex mutation. Not as a security measure — it is not one
 * — but so a guest whose party is paused, or whose photo is 30 MB, is told so
 * before their phone spends a minute of party wifi discovering it.
 *
 * The **upload ticket** and the grant parser are shared with `apps/mobile`.
 *
 * `uploadTicketSchema` is the wire between whichever client is uploading and
 * this app's `/api/uploadthing` middleware, so it cannot live in either client:
 * `apps/mobile` does not depend on the website's build, and when the shape lived
 * here the two sides drifted apart with nothing to catch it. `buildUploadTicket`
 * takes the bound fields from the grant rather than from local state, which is
 * what stops them drifting again.
 */
export {
  buildUploadTicket,
  checkGrantEligibility,
  checkTicketAgainstFiles,
  checkTicketAgainstGrant,
  grantHasExpired,
  GRANT_POLICY,
  grantSizeCap,
  isIssuedGrant,
  isPermanentRejection,
  parseGrantResult,
  TICKET_MISMATCH_MESSAGES,
  UPLOAD_COMPLETION_OUTCOMES,
  UPLOAD_REJECTION_MESSAGES,
  UPLOAD_REJECTION_REASONS,
  UPLOAD_ROUTE_PATH,
  UPLOAD_ROUTE_SLUG,
  UPLOAD_THROTTLED_MESSAGE,
  uploadTicketSchema,
  type GrantResult,
  type IssuedGrant,
  type OfferedFile,
  type UploadCompletionOutcome,
  type UploadRejectionReason,
  type UploadTicket,
} from "@partybooth/contracts/upload";

/**
 * The capture pipeline's arithmetic, shared with `apps/mobile`.
 *
 * The two platforms re-encode through different engines — a `<canvas>` here,
 * `expo-image-manipulator` there — so the *runtime* halves stay in the apps.
 * What is shared is the part that must not diverge: how a size is scaled, how a
 * digest becomes the lower-case hex `checksumSchema` demands, and what a capture
 * id looks like. `DERIVATIVE_PROFILES.web` is this app's row.
 */
export {
  CAPTURE_ID_PREFIXES,
  DERIVATIVE_PROFILES,
  fitWithin,
  isValidCaptureId,
  newCaptureId,
  toHex,
  type DerivativeProfile,
  type PixelSize,
  type RandomBytes,
} from "@partybooth/contracts/capture";

export {
  SIGNED_READ_URL_TTL_SECONDS,
  STORAGE_REGIONS,
  storageRegionSchema,
  type StorageRegion,
} from "@partybooth/contracts/storage";

/* -------------------------------------------------------------------------- */
/* Joining                                                                    */
/* -------------------------------------------------------------------------- */

export {
  JOIN_POLICY,
  JOIN_REJECTED_MESSAGE,
  JOIN_THROTTLED_MESSAGE,
  // The route handler in `app/api/join` validates the invite shape before
  // forwarding it, using the same schema Convex parses with.
  joinInputSchema,
  parseJoinResult,
  type JoinResult,
} from "@partybooth/contracts/join";

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
