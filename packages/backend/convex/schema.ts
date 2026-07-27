import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  accountState,
  auditAction,
  auditSubject,
  deletionJobState,
  deletionSubject,
  eventRole,
  eventState,
  inviteVersionStatus,
  mediaState,
  mediaType,
  membershipStatus,
  moderationActor,
  moderationDecision,
  moderationMode,
  organiserInvitationStatus,
  pushPlatform,
  storageRegion,
} from "./lib/validators";

/**
 * PartyBooth schema v1.
 *
 * Conventions:
 *
 * - **Timestamps are epoch milliseconds.** Convex gives every row
 *   `_creationTime`, but explicit `createdAt` / `updatedAt` survive the
 *   re-creation of a row and read the same on every client.
 * - **Soft deletion everywhere.** Nothing party-related is hard-deleted at
 *   launch; rows move to a terminal state and `deletionJobs` records the intent.
 *   The purge worker is post-launch (P1).
 * - **Indexes are named `by_<fields>`** and exist for the access paths the
 *   product actually has. A query that needs a full scan during a party is a
 *   bug, so every list view here has an index.
 * - Enum unions come from `@partybooth/contracts` via `lib/validators.ts`, so
 *   the database and the permission rules cannot disagree.
 *
 * Better Auth's own tables (user, session, account, verification, jwks) live
 * inside the component and are **not** declared here. `users` below is the
 * application-side mirror, kept in step by the trigger in `auth.ts`.
 */
export default defineSchema({
  /* ------------------------------------------------------------------ */
  /* Identity                                                            */
  /* ------------------------------------------------------------------ */

  users: defineTable({
    /** Better Auth user id (`identity.subject`). The join key to the component. */
    authId: v.string(),
    /** Lower-cased. Apple private-relay addresses land here verbatim. */
    email: v.string(),
    emailVerified: v.boolean(),
    displayName: v.string(),
    /** UploadThing key for the confirmed avatar. */
    avatarKey: v.optional(v.string()),
    /** Apple private relay addresses cannot receive organiser invites. */
    isPrivateRelayEmail: v.optional(v.boolean()),

    accountState,
    /** Invitation-only private beta: `true` unlocks event creation. */
    isOrganiser: v.boolean(),
    /**
     * Mirrored from `ADMIN_EMAIL_ALLOWLIST` at sign-in. The allowlist stays
     * authoritative — this is a cache so `/admin` queries do not need it.
     */
    isGlobalAdmin: v.boolean(),

    lockedAt: v.optional(v.number()),
    lockedByUserId: v.optional(v.id("users")),
    lockReason: v.optional(v.string()),
    deletionScheduledAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),

    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authId", ["authId"])
    .index("by_email", ["email"])
    .index("by_accountState", ["accountState"]),

  /**
   * Organiser invitations. Private beta is invitation-only: an account cannot
   * create an event until one of these has been accepted.
   */
  organiserInvitations: defineTable({
    email: v.string(),
    /** High-entropy single-use token from `generateSecret()`. */
    token: v.string(),
    status: organiserInvitationStatus,
    invitedByUserId: v.id("users"),
    note: v.optional(v.string()),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_token", ["token"])
    .index("by_status", ["status"])
    .index("by_email_and_status", ["email", "status"]),

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  events: defineTable({
    ownerUserId: v.id("users"),
    name: v.string(),
    state: eventState,
    moderationMode,

    /**
     * Which UploadThing region this event's media lives in. Set at creation,
     * **immutable once `firstUploadAt` is set** — files never migrate. Upload
     * grants carry it and the storage adapter resolves the host from it.
     */
    storageRegion,

    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    /** IANA name; the party runs on the host's clock, not the server's. */
    timeZone: v.string(),

    accentColor: v.optional(v.string()),
    coverKey: v.optional(v.string()),
    allowLibraryImport: v.boolean(),

    /** The invite version guests are currently admitted under. */
    activeInviteVersionId: v.optional(v.id("inviteVersions")),

    /**
     * Denormalised counters for the organiser home and the pending badge.
     * Maintained inside the same mutation that changes a media state, so they
     * are exact rather than eventually consistent.
     */
    counts: v.object({
      pending: v.number(),
      approved: v.number(),
      declined: v.number(),
      total: v.number(),
    }),

    /** Locks `storageRegion`. */
    firstUploadAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    deletionScheduledAt: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_state", ["state"])
    .index("by_owner_and_state", ["ownerUserId", "state"]),

  /**
   * One row per rotation of an event's join credentials. Rotating creates a new
   * row and revokes the old one; a QR printed against a revoked version is
   * rejected at join, which is exactly the "kill the old poster" story.
   */
  inviteVersions: defineTable({
    eventId: v.id("events"),
    /** 1-based, monotonic per event. */
    version: v.number(),
    /** Six digits. Unique among versions whose event is joinable. */
    code: v.string(),
    /** 32-character Crockford base32 — the QR / universal-link secret. */
    token: v.string(),
    status: inviteVersionStatus,
    /** Whether memberships from the previous version survived this rotation. */
    keptExistingMemberships: v.optional(v.boolean()),

    createdByUserId: v.id("users"),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    revokeReason: v.optional(v.string()),
  })
    .index("by_event", ["eventId"])
    .index("by_code", ["code"])
    .index("by_token", ["token"])
    .index("by_event_and_status", ["eventId", "status"]),

  /**
   * Who is in an event and in what capacity. The owner gets a membership too,
   * so every permission check has one shape.
   */
  memberships: defineTable({
    eventId: v.id("events"),
    userId: v.id("users"),
    role: eventRole,
    status: membershipStatus,

    /** The invite version that admitted them — what rotation revokes against. */
    inviteVersionId: v.optional(v.id("inviteVersions")),
    /** Set when a co-host was invited by email but has not signed in yet. */
    invitedEmail: v.optional(v.string()),

    joinedAt: v.number(),
    lastActiveAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    revokeReason: v.optional(v.string()),
  })
    .index("by_event", ["eventId"])
    .index("by_user", ["userId"])
    .index("by_event_and_user", ["eventId", "userId"])
    .index("by_event_and_status", ["eventId", "status"])
    .index("by_event_and_role", ["eventId", "role"])
    .index("by_user_and_status", ["userId", "status"]),

  /* ------------------------------------------------------------------ */
  /* Media                                                               */
  /* ------------------------------------------------------------------ */

  media: defineTable({
    eventId: v.id("events"),
    uploaderUserId: v.id("users"),
    /**
     * Client-generated and stable across retries. `by_event_and_capture` is
     * what makes the UploadThing completion callback idempotent and lets an
     * out-of-order callback find its row instead of creating a second one.
     */
    captureId: v.string(),

    state: mediaState,
    mediaType,

    /** UploadThing file key. Absent until the upload completes. */
    storageKey: v.optional(v.string()),
    storageRegion,
    byteSize: v.number(),
    mimeType: v.string(),
    /** Lower-case hex SHA-256, checked against the stored object. */
    checksum: v.string(),
    durationSeconds: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),

    /** Derivatives. Location metadata is stripped from everything served. */
    previewKey: v.optional(v.string()),
    posterKey: v.optional(v.string()),

    fromLibrary: v.boolean(),
    capturedAt: v.optional(v.number()),
    uploadedAt: v.optional(v.number()),

    moderatedAt: v.optional(v.number()),
    moderatedByUserId: v.optional(v.id("users")),
    withdrawnAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_and_state", ["eventId", "state"])
    .index("by_event_and_capture", ["eventId", "captureId"])
    .index("by_event_and_uploader", ["eventId", "uploaderUserId"])
    .index("by_uploader", ["uploaderUserId"])
    .index("by_state", ["state"]),

  /**
   * Append-only history of moderation. One row per decision, including
   * reversals — "who un-declined this at 1am" is a question that gets asked.
   */
  moderationDecisions: defineTable({
    mediaId: v.id("media"),
    eventId: v.id("events"),
    decision: moderationDecision,
    actor: moderationActor,
    /** Absent for `automatic` and (post-launch) `ai` decisions. */
    decidedByUserId: v.optional(v.id("users")),
    previousState: mediaState,
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_media", ["mediaId"])
    .index("by_event", ["eventId"])
    .index("by_event_and_created", ["eventId", "createdAt"])
    .index("by_decidedBy", ["decidedByUserId"]),

  /* ------------------------------------------------------------------ */
  /* Notifications                                                       */
  /* ------------------------------------------------------------------ */

  pushDevices: defineTable({
    userId: v.id("users"),
    /** `ExponentPushToken[…]`. Unique per install. */
    expoPushToken: v.string(),
    platform: pushPlatform,
    deviceName: v.optional(v.string()),
    /** Consecutive Expo delivery failures; a token is disabled after enough. */
    failureCount: v.number(),
    disabledAt: v.optional(v.number()),
    lastSeenAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["expoPushToken"])
    .index("by_user_and_token", ["userId", "expoPushToken"]),

  /* ------------------------------------------------------------------ */
  /* Lifecycle and audit                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Intent to delete an account or an event. Rows are created at launch and
   * honoured by the access checks immediately; the worker that actually purges
   * storage runs from P1 (`scheduledAt` is already ~30 days out).
   */
  deletionJobs: defineTable({
    subjectType: deletionSubject,
    /** `Id<"users">` or `Id<"events">` as a string — the table varies. */
    subjectId: v.string(),
    state: deletionJobState,
    /** When the purge becomes due. */
    scheduledAt: v.number(),
    requestedByUserId: v.optional(v.id("users")),
    reason: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelledByUserId: v.optional(v.id("users")),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_subject", ["subjectType", "subjectId"])
    .index("by_state_and_scheduledAt", ["state", "scheduledAt"]),

  /**
   * Immutable audit log. **Insert only** — nothing in the codebase may patch or
   * delete a row here. Every admin-console action and every security-relevant
   * event (joins, rejections, rotations, moderation) lands here with an actor,
   * a subject and, where the action demands it, a typed reason.
   */
  auditEvents: defineTable({
    action: auditAction,
    subjectType: auditSubject,
    subjectId: v.optional(v.string()),

    actorUserId: v.optional(v.id("users")),
    /** Role the actor was acting in — `globalAdmin`, `owner`, `cohost`, `guest`. */
    actorRole: v.optional(v.string()),
    /** Present only for HTTP-originated actions; scrubbed from Sentry. */
    actorIp: v.optional(v.string()),

    /** Set whenever the action belongs to an event, for the per-event view. */
    eventId: v.optional(v.id("events")),
    reason: v.optional(v.string()),
    /** Small, non-PII detail bag (old/new state, counts, codes rotated). */
    metadata: v.optional(v.record(v.string(), v.any())),

    createdAt: v.number(),
  })
    .index("by_action", ["action"])
    .index("by_actor", ["actorUserId"])
    .index("by_event", ["eventId"])
    .index("by_subject", ["subjectType", "subjectId"])
    .index("by_createdAt", ["createdAt"]),
});
