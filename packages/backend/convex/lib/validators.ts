import {
  ACCOUNT_STATES,
  AUDIT_ACTION_NAMES,
  MEMBERSHIP_STATUSES,
  CAPTURE_STATES,
  EVENT_ROLES,
  EVENT_STATES,
  MEDIA_STATES,
  MEDIA_TYPES,
  MODERATION_ACTORS,
  MODERATION_DECISIONS,
  MODERATION_MODES,
  PUSH_PLATFORMS,
  REPORT_REASONS,
  STORAGE_REGIONS,
} from "@partybooth/contracts";
import { v, type Validator } from "convex/values";

/**
 * Build a Convex union-of-literals validator from a `readonly string[]` in
 * `@partybooth/contracts`.
 *
 * Writing the literals out by hand in the schema would be more idiomatic
 * Convex, but it would also be a second place for the domain vocabulary to
 * live — and the first time someone adds an event state without touching the
 * schema, joins start failing in a way that only shows up at a party. Deriving
 * them means the schema cannot drift from the permission rules.
 */
export function literalUnion<T extends string>(values: readonly T[]): Validator<T> {
  if (values.length === 0) {
    throw new Error("literalUnion needs at least one value");
  }
  if (values.length === 1) {
    return v.literal(values[0] as T) as Validator<T>;
  }
  const members = values.map((value) => v.literal(value));
  type Member = Validator<T, "required", never>;
  return v.union(
    ...(members as unknown as [Member, Member, ...Member[]]),
  ) as unknown as Validator<T>;
}

/* -------------------------------------------------------------------------- */
/* Domain enums, derived from @partybooth/contracts                            */
/* -------------------------------------------------------------------------- */

export const accountState = literalUnion(ACCOUNT_STATES);
export const eventState = literalUnion(EVENT_STATES);
export const eventRole = literalUnion(EVENT_ROLES);
export const moderationMode = literalUnion(MODERATION_MODES);
export const moderationDecision = literalUnion(MODERATION_DECISIONS);
export const moderationActor = literalUnion(MODERATION_ACTORS);
export const mediaState = literalUnion(MEDIA_STATES);
export const mediaType = literalUnion(MEDIA_TYPES);
export const captureState = literalUnion(CAPTURE_STATES);
export const storageRegion = literalUnion(STORAGE_REGIONS);
export const pushPlatform = literalUnion(PUSH_PLATFORMS);
export const reportReason = literalUnion(REPORT_REASONS);
export const auditAction = literalUnion(AUDIT_ACTION_NAMES);

/* -------------------------------------------------------------------------- */
/* Schema-local enums (no cross-client meaning, so not in contracts)           */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle of a row in `memberships`.
 *
 * Defined in `@partybooth/contracts` rather than here because it crosses the
 * wire on `membershipSchema`; re-exported so `@partybooth/backend`'s public
 * entry point keeps the same surface.
 */
export { MEMBERSHIP_STATUSES, type MembershipStatus } from "@partybooth/contracts";
export const membershipStatus = literalUnion(MEMBERSHIP_STATUSES);

/** Lifecycle of a row in `inviteVersions`. Exactly one is `active` per event. */
export const INVITE_VERSION_STATUSES = ["active", "revoked"] as const;
export const inviteVersionStatus = literalUnion(INVITE_VERSION_STATUSES);

/** Lifecycle of a row in `organiserInvitations`. */
export const ORGANISER_INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export const organiserInvitationStatus = literalUnion(ORGANISER_INVITATION_STATUSES);

/**
 * Lifecycle of a row in `cohostInvitations`. Same shape as the organiser one —
 * an invitation addressed to an email that may not have an account yet.
 */
export const COHOST_INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export const cohostInvitationStatus = literalUnion(COHOST_INVITATION_STATUSES);

/**
 * Lifecycle of a row in `userEmails` — an address a user has claimed, and then
 * proven with a six-digit code.
 */
export const USER_EMAIL_STATUSES = ["pending", "verified"] as const;
export const userEmailStatus = literalUnion(USER_EMAIL_STATUSES);

/** What a `deletionJobs` row is about. */
export const DELETION_SUBJECTS = ["user", "event"] as const;
export const deletionSubject = literalUnion(DELETION_SUBJECTS);

/**
 * Lifecycle of a `deletionJobs` row. The 30-day purge worker is post-launch
 * (P1); at launch rows are created in `scheduled` and only ever `cancelled`.
 */
export const DELETION_JOB_STATES = [
  "scheduled",
  "cancelled",
  "running",
  "completed",
  "failed",
] as const;
export const deletionJobState = literalUnion(DELETION_JOB_STATES);

/** What an audit row is about, so a subject id can be interpreted. */
export const AUDIT_SUBJECTS = [
  "user",
  "event",
  "membership",
  "media",
  "inviteVersion",
  "organiserInvitation",
  "platform",
] as const;
export const auditSubject = literalUnion(AUDIT_SUBJECTS);

export type InviteVersionStatus = (typeof INVITE_VERSION_STATUSES)[number];
export type OrganiserInvitationStatus = (typeof ORGANISER_INVITATION_STATUSES)[number];
export type CohostInvitationStatus = (typeof COHOST_INVITATION_STATUSES)[number];
export type UserEmailStatus = (typeof USER_EMAIL_STATUSES)[number];
export type DeletionSubject = (typeof DELETION_SUBJECTS)[number];
export type DeletionJobState = (typeof DELETION_JOB_STATES)[number];
export type AuditSubject = (typeof AUDIT_SUBJECTS)[number];
