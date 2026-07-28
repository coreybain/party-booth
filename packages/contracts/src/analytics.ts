/**
 * Analytics event names.
 *
 * PostHog dashboards are post-launch (P2), but the *names* are fixed now so
 * that whatever gets emitted during the 5 August party is already in the final
 * vocabulary and the first dashboard has real history to draw on.
 *
 * Conventions:
 * - `snake_case`, `object_verb_past_tense` (`media_uploaded`, not `upload`).
 * - No PII in a name, ever. Properties carry ids; ids are not addresses.
 * - Client and server may both emit; `ANALYTICS_EVENT_SOURCES` says which.
 */
export const ANALYTICS_EVENTS = {
  // Auth
  otpRequested: "otp_requested",
  otpVerified: "otp_verified",
  otpFailed: "otp_failed",
  signedIn: "signed_in",
  signedOut: "signed_out",
  accountDeletionRequested: "account_deletion_requested",

  // Events
  eventCreated: "event_created",
  eventUpdated: "event_updated",
  eventStateChanged: "event_state_changed",
  eventModerationModeChanged: "event_moderation_mode_changed",
  inviteRotated: "invite_rotated",
  inviteQrViewed: "invite_qr_viewed",

  // Joining
  joinAttempted: "join_attempted",
  joinSucceeded: "join_succeeded",
  joinRejected: "join_rejected",
  cohostInvited: "cohost_invited",
  membershipRevoked: "membership_revoked",

  // Capture and upload
  captureTaken: "capture_taken",
  captureUndone: "capture_undone",
  uploadGrantIssued: "upload_grant_issued",
  uploadStarted: "upload_started",
  mediaUploaded: "media_uploaded",
  uploadFailed: "upload_failed",
  uploadRetried: "upload_retried",
  mediaWithdrawn: "media_withdrawn",

  // Moderation
  mediaApproved: "media_approved",
  mediaDeclined: "media_declined",
  mediaApprovalRevoked: "media_approval_revoked",
  mediaBulkModerated: "media_bulk_moderated",
  mediaReported: "media_reported",
  mediaReportResolved: "media_report_resolved",
  userBlocked: "user_blocked",
  userUnblocked: "user_unblocked",

  // Viewing
  galleryViewed: "gallery_viewed",
  slideshowStarted: "slideshow_started",
  slideshowStopped: "slideshow_stopped",

  // Notifications
  pushDeviceRegistered: "push_device_registered",
  pushNotificationSent: "push_notification_sent",

  // Admin
  adminConsoleViewed: "admin_console_viewed",
  organiserInvited: "organiser_invited",
  accountLocked: "account_locked",
  accountUnlocked: "account_unlocked",
  accountDeletionScheduled: "account_deletion_scheduled",
  accountDeletionRestored: "account_deletion_restored",
} as const;

export type AnalyticsEventKey = keyof typeof ANALYTICS_EVENTS;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[AnalyticsEventKey];

export const ANALYTICS_EVENT_NAMES = Object.values(
  ANALYTICS_EVENTS,
) as readonly AnalyticsEventName[];

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === "string" && (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Audit-log actions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Actions that must leave an **immutable audit row** (`auditEvents`), separate
 * from analytics. PLAN.md requires "confirmation + reason + immutable audit on
 * every action" in the admin console, and the join/rotation paths are audited
 * for incident response.
 *
 * Analytics can be sampled, dropped or disabled. Audit cannot.
 */
export const AUDIT_ACTIONS = {
  organiserInvited: "organiser.invited",
  organiserInviteRevoked: "organiser.invite_revoked",
  /** A verified email matched a pending invitation and unlocked event creation. */
  organiserInviteAccepted: "organiser.invite_accepted",

  eventCreated: "event.created",
  eventUpdated: "event.updated",
  eventStateChanged: "event.state_changed",
  eventDeleted: "event.deleted",
  eventOwnershipTransferred: "event.ownership_transferred",
  inviteRotated: "event.invite_rotated",

  membershipCreated: "membership.created",
  membershipRevoked: "membership.revoked",
  membershipLeft: "membership.left",
  /**
   * An attempt that was **accepted**, written for every admitted join —
   * including a repeat scan by somebody who was already a member.
   *
   * Separate from {@link AUDIT_ACTIONS.membershipCreated} because that one is
   * about a row appearing, and this one is about a credential being used. Only
   * having the former meant a valid code replayed a thousand times left a
   * single audit row from the first use, which is the shape an attacker uses to
   * hide: "every attempt is audited" has to include the ones that worked.
   */
  joinSucceeded: "membership.join_succeeded",
  joinRejected: "membership.join_rejected",
  cohostInvited: "membership.cohost_invited",
  /** A verified email matched a pending co-host invite and was elevated. */
  cohostInviteAccepted: "membership.cohost_invite_accepted",

  /**
   * A short-lived upload grant was issued. Audited, not merely counted, because
   * it is the only record that ties an account to a capture *before* any bytes
   * exist — which is what an incident on party night has to reason from when the
   * media row was never created.
   */
  uploadGranted: "media.upload_granted",
  /** A grant was refused: wrong event state, library import off, over the cap. */
  uploadRejected: "media.upload_rejected",
  /**
   * A grant was spent and a file attached. One row per *accepted* completion —
   * duplicate callbacks are no-ops and deliberately leave nothing, or a provider
   * retry storm would drown the log it is supposed to explain.
   */
  uploadCompleted: "media.upload_completed",
  /**
   * A stored object was refused or orphaned and is being deleted: a body that
   * did not match its grant, a second file against one grant, or a callback for
   * a capture that had already been withdrawn.
   */
  uploadDiscarded: "media.upload_discarded",
  mediaModerated: "media.moderated",
  mediaWithdrawn: "media.withdrawn",
  mediaDeleted: "media.deleted",
  /** The bytes themselves left storage. Separate from the record's tombstone. */
  mediaFilePurged: "media.file_purged",
  /**
   * A purge did **not** finish: the provider refused every retry, or it reported
   * fewer deletions than objects it was handed.
   *
   * Its own action rather than a flag on {@link AUDIT_ACTIONS.mediaFilePurged},
   * because "withdrawal is permanent" is the invariant this contradicts and a
   * contradiction of an invariant has to be greppable. The row is left with
   * `deletedAt` set, `storageDeletedAt` unset and its keys intact so
   * `media.stuckPurges` can list it and a retry has something to name.
   */
  mediaFilePurgeFailed: "media.file_purge_failed",
  /**
   * A derivative — a preview or a video poster — was attached to a capture that
   * already existed.
   *
   * Separate from {@link AUDIT_ACTIONS.uploadCompleted} because that action
   * means "a guest's submission landed" and drives the counters and the
   * moderation queue, while this one changes nothing a host sees. Folding them
   * together would triple the apparent submission count of every party.
   */
  derivativeAttached: "media.derivative_attached",
  mediaReported: "media.reported",
  /** A host looked at a report and either acted on it or dismissed it. */
  mediaReportResolved: "media.report_resolved",

  /** One guest blocked another. Per-account, event recorded as context. */
  userBlocked: "user.blocked",
  userUnblocked: "user.unblocked",

  /** An additional address was proven by OTP (Apple private-relay path). */
  accountEmailVerified: "account.email_verified",
  accountLocked: "account.locked",
  accountUnlocked: "account.unlocked",
  accountDeletionScheduled: "account.deletion_scheduled",
  accountDeletionRestored: "account.deletion_restored",
  accountDeleted: "account.deleted",

  adminSignedIn: "admin.signed_in",
  adminSignInRejected: "admin.sign_in_rejected",

  /**
   * The App Review reviewer signed in with the fixed demo code.
   *
   * Audited on **every** use, and deliberately its own action rather than a flag
   * on a normal sign-in: a credential that skips the live OTP is the one
   * credential whose every use has to be countable afterwards. If this action
   * ever appears in a deployment real guests are using, that is the incident.
   */
  demoSignIn: "auth.demo_sign_in",
} as const;

export type AuditActionKey = keyof typeof AUDIT_ACTIONS;

export type AuditAction = (typeof AUDIT_ACTIONS)[AuditActionKey];

export const AUDIT_ACTION_NAMES = Object.values(AUDIT_ACTIONS) as readonly AuditAction[];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTION_NAMES as readonly string[]).includes(value);
}

/**
 * Audit actions the admin console must not perform without a typed reason.
 * Everything destructive or account-affecting is on this list.
 */
export const AUDIT_ACTIONS_REQUIRING_REASON = [
  AUDIT_ACTIONS.accountLocked,
  AUDIT_ACTIONS.accountUnlocked,
  AUDIT_ACTIONS.accountDeletionScheduled,
  AUDIT_ACTIONS.accountDeletionRestored,
  AUDIT_ACTIONS.eventDeleted,
  AUDIT_ACTIONS.membershipRevoked,
  AUDIT_ACTIONS.inviteRotated,
] as const satisfies readonly AuditAction[];

export function auditActionRequiresReason(action: AuditAction): boolean {
  return (AUDIT_ACTIONS_REQUIRING_REASON as readonly AuditAction[]).includes(action);
}
