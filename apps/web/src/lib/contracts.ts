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
  AVATAR_JPEG_QUALITY,
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPE,
  AVATAR_UPLOAD_ROUTE_PATH,
  AVATAR_UPLOAD_ROUTE_SLUG,
  avatarPixelSize,
  avatarUploadRequestSchema,
  avatarUploadTicketSchema,
  parseAvatarUploadCompletionResult,
  buildAvatarUploadTicket,
  checkAvatarTicketAgainstFiles,
  checkAvatarTicketAgainstGrant,
  type AvatarUploadCompletionResult,
  type AvatarUploadTicket,
  type IssuedAvatarUploadGrant,
} from "@partybooth/contracts/avatar";

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
 * Invite rotation, Sprint 5.
 *
 * `canRotateInvite` and `registerRotation` are the **same** pure budget the
 * Convex mutation charges (`convex/lib/rotation_throttle.ts` persists what they
 * compute). Running them client-side is what lets the rotate button grey itself
 * out with a countdown after the fifth rotation in an hour, instead of offering
 * a control whose only outcome is a `rateLimited` error — and because it is one
 * definition, the countdown cannot disagree with the refusal.
 *
 * `validateSpecificEventCode` is the admin console's collision-and-entropy check
 * for a chosen six digits. It is deliberately **not** the whole check: only
 * Convex can know whether another party already holds that number.
 *
 * `ROTATION_CONSEQUENCES` is the keep-or-revoke copy, shared with the app's Host
 * tab. Both surfaces offer the same irreversible choice, so they describe it in
 * the same sentences or one of them is lying.
 */
export {
  canRotateInvite,
  eventCodeSchema,
  keepExistingMemberships,
  registerRotation,
  ROTATION_CONSEQUENCES,
  ROTATION_POLICY,
  ROTATION_THROTTLED_MESSAGE,
  validateSpecificEventCode,
  type RotationAttemptState,
  type RotationChoice,
  type RotationConsequence,
  type RotationDecision,
  type SpecificCodeRejection,
} from "@partybooth/contracts/codes";

/**
 * Account lifecycle, for the admin console and the locked screens.
 *
 * `accountStateMachine` is what decides which of lock / unlock / schedule
 * deletion / restore a row is offered: the console reads the legal transitions
 * rather than hand-writing a second copy of the table that Convex would then
 * refuse.
 */
export {
  ACCOUNT_STATES,
  accountStateMachine,
  canAccountSignIn,
  isAccountActive,
  type AccountState,
} from "@partybooth/contracts/accounts";

/**
 * The audit vocabulary the `/admin` log viewer renders and filters on.
 *
 * `AUDIT_ACTIONS_REQUIRING_REASON` is not decoration: the console must not offer
 * a confirm button for one of those actions until a reason has been typed, and
 * `writeAuditEvent` in Convex throws rather than writing a blank one. Two halves
 * of one rule, from one list.
 */
export {
  ADMIN_CONSOLE_AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_REQUIRING_REASON,
  auditActionRequiresReason,
  isAuditAction,
  type AuditAction,
  type AuditActionKey,
} from "@partybooth/contracts/analytics";

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
  eventAcceptsUploads,
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
  uploadGrantRequestSchema,
  updateEventInputSchema,
} from "@partybooth/contracts/schemas";

/**
 * The input schemas the Sprint 5 forms validate against.
 *
 * `adminReasonSchema` is the one that matters: PLAN.md's rule for the console is
 * "confirmation + reason + immutable audit on **every** action", and this is the
 * definition both the form and `parseInput` in Convex run. A reason the console
 * accepted and the backend refused would be the worst of both.
 */
export {
  ADMIN_ROTATION_MODES,
  adminReasonSchema,
  adminRotateCodeInputSchema,
  emailSchema,
  inviteCohostInputSchema,
  inviteOrganiserInputSchema,
  MEMBERSHIP_STATUSES,
  type AdminRotationMode,
  type MembershipStatus,
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
  allowedMimeTypesForRole,
  CAPTURE_STATES,
  captureStateMachine,
  canSeeMedia,
  DERIVATIVE_LIMITS,
  derivativeRolesFor,
  isCaptureInFlight,
  isDerivativeRole,
  isFileRoleAllowed,
  isTerminalCapture,
  MEDIA_FILE_ROLES,
  MEDIA_LIMITS,
  MEDIA_SOURCES,
  MEDIA_STATES,
  MEDIA_TYPES,
  maxBytesFor,
  maxBytesForRole,
  mediaSourceOf,
  mediaStateSchema,
  mediaTypeSchema,
  validateMediaFile,
  VIDEO_MAX_DURATION_SECONDS,
  type CaptureState,
  type DerivativeFileRole,
  type MediaFileRole,
  type MediaSource,
  type MediaState,
  type MediaType,
} from "@partybooth/contracts/media";

/**
 * Moderation and reporting, Sprint 4.
 *
 * `moderationTransition` is the reason the moderation grid can grey out a button
 * without asking Convex: it is the *same* function `moderation.moderate` runs
 * per item, so "Revoke is not offered on a pending card" and "revoke refuses
 * anything that is not approved" are one rule with one test, rather than a
 * server rule and a UI guess that agree until somebody edits one of them.
 *
 * The bulk bar's counts come from it too — "Approve 12" counts the items that
 * would actually move, not the items that happen to be selected, because a
 * selection made thirty seconds ago at a live party contains things another host
 * has already dealt with.
 */
export {
  MODERATION_ACTIONS,
  MODERATION_REFUSAL_MESSAGES,
  moderationTransition,
  REPORT_REASONS,
  type ModerationActionName,
  type ModerationRefusal,
  type ModerationTransition,
  type ReportReason,
  type ReportStatus,
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
  parseUploadCallbackResult,
  TICKET_MISMATCH_MESSAGES,
  UPLOAD_COMPLETION_OUTCOMES,
  UPLOAD_REJECTION_MESSAGES,
  UPLOAD_REJECTION_REASONS,
  UPLOAD_ROUTE_PATH,
  UPLOAD_ROUTE_SLUG,
  UPLOAD_THROTTLED_MESSAGE,
  uploadTicketSchema,
  uploadCallbackSucceeded,
  type GrantResult,
  type IssuedGrant,
  type OfferedFile,
  type UploadCompletionOutcome,
  type UploadCallbackResult,
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
  derivativeFileName,
  fitWithin,
  isValidCaptureId,
  newCaptureId,
  posterFrameTime,
  toHex,
  videoContainerFor,
  type DerivativeKind,
  type DerivativeProfile,
  type PixelSize,
  type RandomBytes,
} from "@partybooth/contracts/capture";

/**
 * Copy and formatters that both clients show.
 *
 * Here for the same reason the state machines are: a report category a guest
 * picks on their phone and a host reads on a laptop has to mean one thing, and a
 * size or a duration rendered two ways from one number is a support question.
 */
export {
  formatBytes,
  formatDuration,
  formatReportCount,
  REPORT_REASON_LABELS,
  REPORT_REASON_PROMPTS,
  REPORT_STATUS_LABELS,
  type ReportReasonPrompt,
} from "@partybooth/contracts/copy";

export {
  SIGNED_HOST_REVIEW_URL_TTL_SECONDS,
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

/**
 * The user terms.
 *
 * The rules and the version live in the contract so this page, the acceptance
 * prompt on both clients and the report sheet cannot drift; the prose lives at
 * `/terms`. See `packages/contracts/src/terms.ts`.
 */
export {
  COMMUNITY_RULES,
  hasAcceptedTerms,
  PROHIBITED_CONTENT,
  TERMS_ACCEPTANCE_PROMPT,
  TERMS_PATH,
  TERMS_VERSION,
  type ProhibitedContentRule,
} from "@partybooth/contracts/terms";
