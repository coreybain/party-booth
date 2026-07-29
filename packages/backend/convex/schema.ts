import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  accountState,
  auditAction,
  auditSubject,
  cohostInvitationStatus,
  deletionJobState,
  deletionSubject,
  eventRole,
  eventState,
  inviteVersionStatus,
  mediaFileRole,
  mediaState,
  mediaType,
  membershipStatus,
  moderationActor,
  moderationDecision,
  moderationMode,
  organiserInvitationStatus,
  pushCategory,
  pushDeliveryState,
  pushPlatform,
  reportReason,
  reportStatus,
  storageRegion,
  uploadGrantStatus,
  userEmailStatus,
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
    /**
     * When this human confirmed their own name (and photo) — PLAN.md's "then
     * name + photo confirmation".
     *
     * It exists because `displayName` cannot answer the question: it is never
     * empty (it falls back to the local part of the address), so "Sam chose
     * this" and "we guessed this" are indistinguishable from it. Two things
     * read the distinction: the clients decide whether to show the onboarding
     * screen, and `auth.ts`'s `onUpdate` trigger stops overwriting the name
     * with the identity provider's once it is set — a provider name is a
     * default, and a default must never clobber a choice.
     */
    onboardedAt: v.optional(v.number()),
    /** Apple private relay addresses cannot receive organiser invites. */
    isPrivateRelayEmail: v.optional(v.boolean()),

    /**
     * The version of the user terms this account accepted, and when.
     *
     * Both Play's UGC policy and Apple's guideline 1.2 ask for terms that define
     * and prohibit objectionable content *and* for the user to have accepted
     * them. A published page nobody agreed to satisfies neither, which is what
     * the repository had — no terms at all, and a store listing that said the
     * follow-ups were done.
     *
     * Versioned rather than a boolean, because the question that gets asked
     * afterwards is "which text did they agree to". `TERMS_VERSION` in
     * `@partybooth/contracts/terms` is compared for equality, so bumping it asks
     * everybody again — see `hasAcceptedTerms`.
     */
    acceptedTermsVersion: v.optional(v.string()),
    acceptedTermsAt: v.optional(v.number()),

    accountState,
    /** Invitation-only private beta: `true` unlocks event creation. */
    isOrganiser: v.boolean(),
    /**
     * Mirrored from `ADMIN_EMAIL_ALLOWLIST` at sign-in. The allowlist stays
     * authoritative — this is a cache so `/admin` queries do not need it.
     */
    isGlobalAdmin: v.boolean(),

    /**
     * Which push categories this account has switched **off**, and the queue
     * depth at which a host wants to be told.
     *
     * An opt-out list rather than a map of booleans: adding a category must
     * default to *on* for every account that has never seen the toggle, and a
     * map would need a migration to say so. Absent means "everything on, default
     * threshold", which is what every row written before Sprint 5 means — so
     * this is additive and nothing stored changes behaviour. The policy that
     * reads it is pure and lives in `@partybooth/contracts/push`.
     */
    notificationOptOut: v.optional(v.array(pushCategory)),
    pendingNotifyThreshold: v.optional(v.number()),

    lockedAt: v.optional(v.number()),
    lockedByUserId: v.optional(v.id("users")),
    lockReason: v.optional(v.string()),
    deletionScheduledAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),

    /**
     * Which event this user's Camera / Host tabs are pointed at. A per-user
     * setting rather than client state, because the phone in your pocket and
     * the laptop on the table should agree about which party you are at.
     * Cleared when the membership behind it goes away.
     */
    activeEventId: v.optional(v.id("events")),

    /**
     * This row was written by `demo.seedDemoEvent`, not by an authentication.
     *
     * It exists for one reason: the seeded reviewer has to become the *same*
     * account the reviewer signs into. The seed cannot reach inside Better
     * Auth's tables to pre-create a user, so it writes a mirror row with a
     * placeholder `authId`, and the `user.onCreate` trigger adopts that row —
     * matching on the normalised address — instead of inserting a second one.
     * Without it the reviewer signed into an account with no membership of the
     * seeded party and found an empty shell.
     *
     * Adoption is deliberately confined to rows carrying this flag. Adopting any
     * matching address would mean a mirror row could be claimed by whoever next
     * signs up with that address, which is a different and much worse feature.
     */
    seeded: v.optional(v.boolean()),

    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authId", ["authId"])
    .index("by_email", ["email"])
    .index("by_accountState", ["accountState"]),

  /**
   * Additional email addresses a user has proven with a six-digit code.
   *
   * Exists for one case from PLAN.md: a guest who signs in with Apple gets a
   * `@privaterelay.appleid.com` address, which cannot receive an organiser or
   * co-host invitation. They add a real address here, verify it with the same
   * OTP infrastructure, and verified-email matching then runs against it.
   *
   * A `pending` row holds a **hashed** code — a leak of this table must not be
   * a leak of a usable credential — plus the attempt counter, exactly like the
   * budget Better Auth enforces for sign-in codes.
   */
  userEmails: defineTable({
    userId: v.id("users"),
    /** Trimmed, lower-cased. */
    email: v.string(),
    status: userEmailStatus,
    /** Lower-case hex SHA-256 of the code. Absent once verified. */
    codeHash: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    /** Wrong guesses so far against the current code. */
    attempts: v.number(),
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_email", ["email"])
    .index("by_user_and_email", ["userId", "email"])
    .index("by_email_and_status", ["email", "status"]),

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

  /**
   * Per-address OTP send throttle.
   *
   * Better Auth's own rate limiter is not usable for this: it defaults to an
   * in-memory `Map` per isolate, and Convex recycles and parallelises isolates,
   * so the counters are never shared. This table is what actually enforces the
   * 60-second resend cooldown and the hourly send ceiling from PLAN.md
   * ("rate limits + enumeration protection on join and OTP").
   *
   * It holds **no code and no attempt counter** — Better Auth owns verification
   * and stores the code hashed. One row per normalised email address, upserted
   * on every send.
   */
  otpChallenges: defineTable({
    /** Trimmed, lower-cased. The rate-limit key, not a user reference. */
    email: v.string(),
    lastSentAt: v.number(),
    sendCount: v.number(),
    windowStartedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),

  /**
   * Per-key join throttle — the same pattern as `otpChallenges`, and for the
   * same reason.
   *
   * A six-digit code is a million values. Without a shared counter, "rate
   * limits + enumeration protection on join" (PLAN.md) is unenforceable: Convex
   * parallelises and recycles isolates, so anything in memory is not a limit.
   * Doing the read-decide-write inside a mutation makes it transactional, so
   * two simultaneous guesses cannot both spend the same budget slot.
   *
   * `key` is namespaced (`user:<id>`, `net:<hash>`) so an account key and a
   * network key can share the table without colliding. It holds **no code and
   * no event id** — a throttle row must not become a second record of which
   * codes were tried.
   */
  joinAttempts: defineTable({
    key: v.string(),
    failureCount: v.number(),
    windowStartedAt: v.number(),
    lastAttemptAt: v.number(),
    /** Set when the failure ceiling is hit; cleared by a success. */
    lockedUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

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

    /**
     * The App Review demo party, seeded by `demo.seedDemoEvent`.
     *
     * The demo identity is confined to events carrying this flag —
     * `assertDemoConfinement` in `lib/guards.ts` refuses it every other one, at
     * join and on every event-scoped read and write. Before that, the only thing
     * keeping the published reviewer credentials out of real parties was that
     * nobody had handed them a code, which is an absence rather than a control.
     */
    isDemo: v.optional(v.boolean()),

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
    /**
     * Whether this membership was swept away by an invite **rotation** rather
     * than removed by a host.
     *
     * The two look identical in the row and are not the same decision, and the
     * join path has to tell them apart. A host removing somebody is a judgement
     * about that person, and a fresh scan of a valid QR must not undo it. A
     * rotation that does not keep memberships is a judgement about the
     * *credential* — everybody goes, nobody is accused — and TODO.md is explicit
     * that those people "can rejoin only via the new code", which is exactly
     * what they are holding when they come back.
     *
     * Absent means "removed deliberately", which is what every revoked row
     * written before Sprint 5 means, so nothing stored changes meaning. Cleared
     * when the membership is re-activated.
     */
    revokedByRotation: v.optional(v.boolean()),
  })
    .index("by_event", ["eventId"])
    .index("by_user", ["userId"])
    .index("by_event_and_user", ["eventId", "userId"])
    .index("by_event_and_status", ["eventId", "status"])
    .index("by_event_and_role", ["eventId", "role"])
    .index("by_user_and_status", ["userId", "status"]),

  /**
   * A co-host invited by email who does not have an account yet — or has one
   * under a different address.
   *
   * `memberships` cannot hold this: its `userId` is required, and the whole
   * point is that the person may not exist in `users` at all. When they sign in
   * and a **verified** address matches, `lib/email_matching.ts` turns the row
   * into a `cohost` membership. Until then it is a promise, not a permission.
   *
   * The invite-sending UI is Sprint 5; the model and the matching land now so
   * that an address invited today is honoured the moment its owner appears.
   */
  cohostInvitations: defineTable({
    eventId: v.id("events"),
    /** Trimmed, lower-cased. */
    email: v.string(),
    status: cohostInvitationStatus,
    invitedByUserId: v.id("users"),

    /**
     * High-entropy value that addresses the invitation in the email link.
     *
     * It is **not** a credential and it must never become one. Acceptance binds
     * on a *verified* address matching `email` (`lib/email_matching.ts`), which
     * is the whole reason this table can exist at all for a person who has no
     * account yet — so what the token buys is a link that lands on the right
     * party with the right explanation, not a seat. Anyone forwarding the email
     * hands on a URL that shows them somebody else's invitation and grants them
     * nothing.
     *
     * Optional because the rows Sprint 2 wrote have no token; those are still
     * matchable, they simply have no link to re-send.
     */
    token: v.optional(v.string()),
    /** Withdrawing an invitation is an audited action and carries a reason. */
    revokeReason: v.optional(v.string()),

    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_event", ["eventId"])
    .index("by_token", ["token"])
    .index("by_event_and_email", ["eventId", "email"])
    .index("by_event_and_status", ["eventId", "status"])
    .index("by_email_and_status", ["email", "status"]),

  /* ------------------------------------------------------------------ */
  /* Media                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Short-lived, single-use permission to put one exact file into storage.
   *
   * A guest never holds an UploadThing credential. They ask for one of these,
   * bound to `{eventId, captureId, mediaType, byteSize, checksum,
   * storageRegion}`, and the route handler in `apps/web` refuses to store
   * anything that does not present one. The policy — two-minute TTL, per-account
   * ceiling, what counts as a match — lives in `@partybooth/contracts/upload`
   * and is pure; this table is only where it is written down.
   *
   * **The secret is stored hashed**, exactly like the OTP codes in `userEmails`:
   * a leak of this table must not be a leak of a usable capability. The
   * plaintext is returned once, to the client that asked, and never logged or
   * audited.
   *
   * Consumption is a read-decide-write inside one Convex mutation, which is a
   * serialisable transaction — so two racing uploads cannot both spend the same
   * grant, and the "single use" in single-use is enforced by the database rather
   * than by hoping.
   */
  uploadGrants: defineTable({
    eventId: v.id("events"),
    userId: v.id("users"),
    /** Client-generated and stable across retries. Ties the grant to a capture. */
    captureId: v.string(),

    /** Lower-case hex SHA-256 of the secret handed to the client. */
    secretHash: v.string(),
    status: uploadGrantStatus,

    mediaType,
    /**
     * Which artefact of the capture this grant authorises — the submitted frame
     * or one of its derivatives (ADR 0008).
     *
     * Optional in the schema and read through `fileRoleOf`, because every grant
     * minted before Sprint 4 is an original and carries no value here. It is
     * part of what a completion is checked against: a preview grant may not be
     * spent on a 20 MB body, and an original grant may not be spent on a file
     * that would land in `previewKey`.
     */
    fileRole: v.optional(mediaFileRole),
    /** `true` when the file came from the photo roll — gated per event. */
    fromLibrary: v.boolean(),
    /** Copied from the event at issue time; the media row records it too. */
    storageRegion,

    byteSize: v.number(),
    mimeType: v.string(),
    /** Lower-case hex SHA-256 the completion is checked against. */
    checksum: v.string(),
    durationSeconds: v.optional(v.number()),
    capturedAt: v.optional(v.number()),
    /** The client's claim that it **re-encoded** the bytes before uploading. */
    sourceMetadataStripped: v.optional(v.boolean()),
    /**
     * The client's separate claim that the file **carries no location**.
     *
     * Absent means "same as the re-encode claim" (`metadataClaimOf` in
     * `@partybooth/contracts/media`), which is what every grant minted before
     * Sprint 4 meant — so this is additive and no stored row changes meaning.
     */
    sourceCarriesNoLocation: v.optional(v.boolean()),

    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    /** Set on consumption, so a duplicate callback can recognise its own file. */
    consumedFileKey: v.optional(v.string()),
    /** The row this grant produced. Absent until something completes. */
    mediaId: v.optional(v.id("media")),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_secretHash", ["secretHash"])
    .index("by_event_and_capture", ["eventId", "captureId"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),

  /**
   * Per-account upload-grant counter — the same pattern as `otpChallenges` and
   * `joinAttempts`, and for the same reason: Convex parallelises and recycles
   * isolates, so a counter in memory is not a limit.
   *
   * It differs from `joinAttempts` in what it counts. Joining throttles
   * *failures*; issuing a grant throttles *successes*, because the grant itself
   * is the scarce thing. Separate table rather than a namespaced key in the join
   * one, so that a guest fumbling a six-digit code can never eat into the budget
   * they need to send the photo they came here to send.
   */
  uploadAttempts: defineTable({
    key: v.string(),
    issuedCount: v.number(),
    windowStartedAt: v.number(),
    lastIssuedAt: v.number(),
    /** Set when the ceiling is hit; cleared only by the window rolling over. */
    cooldownUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

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

    /**
     * The grant this row was created from.
     *
     * Kept so a duplicate or out-of-order completion callback can be recognised
     * as belonging to a row that already exists, and so an incident can be
     * walked backwards from a file to the account that was allowed to send it.
     */
    grantId: v.optional(v.id("uploadGrants")),

    /** UploadThing file key. Absent until the upload completes. */
    storageKey: v.optional(v.string()),
    storageRegion,
    byteSize: v.number(),
    mimeType: v.string(),
    /** Lower-case hex SHA-256, checked against the stored object. */
    checksum: v.string(),
    durationSeconds: v.optional(v.number()),
    /**
     * Whether `durationSeconds` was read out of the stored object rather than
     * taken from the client.
     *
     * The 60-second cap used to be checked twice and independently zero times:
     * the grant judged the client's estimate, and the completion callback
     * forwards `metadata.durationSeconds`, which the route handler copies off
     * the client-authored upload ticket. `media.verifyVideoDuration` fetches the
     * file's own header and reads the container's duration; `true` means it
     * agreed with the cap, `false` means the check ran and could not confirm
     * (an unrecognised container, or storage unreachable), and absent means it
     * has not run yet or the row is not a video.
     */
    durationVerified: v.optional(v.boolean()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),

    /**
     * Derivatives — the artefacts everybody except the submitter and the hosts
     * is actually served.
     *
     * `previewKey` is a downscaled image for a photo and a short muted clip for
     * a video; `posterKey` is a video's still frame. Both are produced by the
     * **client**, re-encoded, and uploaded through the same bound single-use
     * grant spine as the original under the same `captureId` with a different
     * `fileRole` (ADR 0008). A derivative grant is refused unless it claims the
     * re-encode, which is the difference between this and the original's
     * `sourceMetadataStripped` — that one is recorded, this one is required.
     *
     * `previewByteSize` / `posterByteSize` exist so the organiser's storage
     * figure counts what is actually stored rather than only the originals.
     */
    previewKey: v.optional(v.string()),
    previewByteSize: v.optional(v.number()),
    posterKey: v.optional(v.string()),
    posterByteSize: v.optional(v.number()),

    /**
     * The derivatives' own checksums and location claims.
     *
     * Both exist to make the re-encode claim falsifiable without an image
     * pipeline, which it was not: the claim was required at grant time and then
     * read by nothing, while `projectMedia` minted `previewUrl` for every viewer
     * unconditionally. That made the derivative slot the way around
     * `mayServeOriginal` — re-upload the withheld original under
     * `fileRole: "preview"` and the whole gallery is served it.
     *
     * The checksum is compared against the original's (and the sibling
     * derivative's) before a grant is issued and again before the object is
     * attached: a decode/re-encode round trip never reproduces its input byte for
     * byte, so equality means "this is the original, re-labelled".
     *
     * The location flag is the read-path half — `mayServeDerivative` withholds a
     * derivative that cannot promise it from anyone but the submitter and the
     * hosts, exactly as `mayServeOriginal` does for the original. Absent means
     * "inherit the original's claim", so no stored row changes visibility.
     */
    previewChecksum: v.optional(v.string()),
    previewCarriesNoLocation: v.optional(v.boolean()),
    posterChecksum: v.optional(v.string()),
    posterCarriesNoLocation: v.optional(v.boolean()),

    fromLibrary: v.boolean(),
    /**
     * Whether the client **re-encoded** the frame before it left the device. See
     * ADR 0004: client-side stripping is the chosen strategy, and this records
     * whether it actually happened for this item rather than assuming it did.
     *
     * This is the half a **derivative grant requires** — a preview that is not a
     * re-encode is refused before a grant exists.
     */
    sourceMetadataStripped: v.optional(v.boolean()),
    /**
     * Whether the file **carries no location fix**, which is the question the
     * read path actually needs answered.
     *
     * Split from `sourceMetadataStripped` in Sprint 4 because the two stopped
     * being the same fact once video existed: a clip cannot be re-encoded on a
     * phone, but `apps/mobile` ships no location permission on either platform,
     * so it can promise the second without the first. `apps/web` can promise
     * neither for a clip picked from a camera roll.
     *
     * **Read on the read path**, not merely recorded: `mayServeOriginal` omits
     * the original's URL entirely for an item that cannot promise this, unless
     * the viewer is the submitter or a host. Absent means "same as the re-encode
     * claim", so every pre-Sprint-4 row keeps exactly the visibility it had.
     */
    sourceCarriesNoLocation: v.optional(v.boolean()),
    capturedAt: v.optional(v.number()),
    uploadedAt: v.optional(v.number()),

    moderatedAt: v.optional(v.number()),
    moderatedByUserId: v.optional(v.id("users")),

    /**
     * When this item most recently became `approved` — the slideshow's clock.
     *
     * Separate from `moderatedAt`, which moves on a decline and on a revoke too.
     * The slideshow's cursor used to run on `createdAt`, which is *capture*
     * order, and that is not the order approvals happen in: a photo taken at
     * eight o'clock and approved at midnight sits behind a cursor that passed it
     * hours ago, so it never reached the television until the five-minute full
     * refresh. "Approve on the laptop and it is on the wall a moment later" is
     * the whole feature.
     *
     * Set by `settleAfterProcessing` (automatic mode) and by `applyModeration`
     * (a host's approve). Left in place on a decline or a revoke: the row leaves
     * the index the moment its state moves, and keeping the timestamp means a
     * re-approval is a new one and sorts as one.
     */
    approvedAt: v.optional(v.number()),

    /**
     * When a member first reported this item, and how many have.
     *
     * Denormalised onto the row rather than counted from `mediaReports` on every
     * read for the same reason the event counters are: the host's flagged view
     * is a live subscription during a party, and a per-item sub-query is a
     * per-item sub-query. `mediaReports` stays the record of *who* and *why*;
     * these two are the badge.
     *
     * `flaggedAt` is cleared when the last open report is resolved, so "flagged"
     * means "somebody is waiting on a host", not "somebody once complained".
     */
    flaggedAt: v.optional(v.number()),
    reportCount: v.optional(v.number()),

    withdrawnAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    /**
     * When the bytes actually left storage, which is a later and less certain
     * event than the record being tombstoned. The mutation cannot call the
     * provider — a Convex mutation has no network — so withdrawal schedules the
     * delete and this is stamped when it lands — **only on a full delete**, so
     * a provider that removed fewer objects than it was handed leaves the keys
     * on the row rather than orphaning the bytes they name.
     *
     * A row with `deletedAt` and no `storageDeletedAt` is one the purge worker
     * still owes work on, and `media.stuckPurges` is what lists them until that
     * worker (P1) ships.
     */
    storageDeletedAt: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_and_state", ["eventId", "state"])
    .index("by_event_state_and_created", ["eventId", "state", "createdAt"])
    /**
     * The slideshow's index.
     *
     * **Approval** order over one state, resumable from a cursor: a TV left
     * running all night asks for "approved items after the last one I have"
     * every time the subscription re-runs, and without this that is a full scan
     * of the party's media on every approval.
     *
     * Approval order rather than capture order because the cursor is what makes
     * the show live, and a cursor that advances by capture time silently drops
     * every item approved out of capture order — which is most of them, once a
     * host works through a backlog.
     */
    .index("by_event_state_and_approved", ["eventId", "state", "approvedAt"])
    .index("by_event_and_capture", ["eventId", "captureId"])
    .index("by_event_and_uploader", ["eventId", "uploaderUserId"])
    .index("by_uploader", ["uploaderUserId"])
    .index("by_state", ["state"]),

  /**
   * A member's report of somebody else's media — the App Review "report
   * objectionable content" requirement, and the host's flagged queue.
   *
   * A report is **not** a moderation decision and does not move the media state.
   * It raises `media.flaggedAt` so the item surfaces at the top of the host's
   * queue, and a host then approves, declines or dismisses. Auto-hiding on
   * report would hand any guest a veto over any other guest's photo.
   *
   * One open row per `(mediaId, reporterUserId)`: reporting twice is a person
   * pressing the button twice, not two complaints.
   */
  mediaReports: defineTable({
    mediaId: v.id("media"),
    eventId: v.id("events"),
    reporterUserId: v.id("users"),
    reason: reportReason,
    /** The reporter's own words. Free text, capped, never shown to the uploader. */
    details: v.optional(v.string()),
    status: reportStatus,
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_media", ["mediaId"])
    .index("by_event", ["eventId"])
    .index("by_event_and_status", ["eventId", "status"])
    .index("by_media_and_reporter", ["mediaId", "reporterUserId"]),

  /**
   * One guest choosing not to see another — the App Review "block abusive
   * users" requirement.
   *
   * **Per-account and global**, not per-event: someone you have blocked is
   * someone you have blocked, and a block that evaporated when the same two
   * people turned up at a second party would not be a block. `eventId` records
   * where it was made, for the audit row and nothing else.
   *
   * It is a *view* filter, not a moderation action. Nothing about the blocked
   * person's media changes for anyone else, and the blocked person is never told
   * — a block that notifies is a block nobody dares use.
   */
  userBlocks: defineTable({
    blockerUserId: v.id("users"),
    blockedUserId: v.id("users"),
    /** Where the block was made. Context for the audit trail, not a scope. */
    eventId: v.optional(v.id("events")),
    createdAt: v.number(),
  })
    .index("by_blocker", ["blockerUserId"])
    .index("by_blocker_and_blocked", ["blockerUserId", "blockedUserId"])
    .index("by_blocked", ["blockedUserId"]),

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

  /**
   * One row per install that has agreed to be notified.
   *
   * Keyed on the **token**, not on the person: an Expo push token belongs to an
   * app installation, and the same phone handed to a second guest at a party
   * must not keep buzzing for the first one. `register` therefore reassigns a
   * token that turns up under a new account rather than inserting a second row —
   * see `push.registerDevice`.
   */
  pushDevices: defineTable({
    userId: v.id("users"),
    /** `ExponentPushToken[…]`. Unique per install. */
    expoPushToken: v.string(),
    platform: pushPlatform,
    deviceName: v.optional(v.string()),
    /** Consecutive Expo delivery failures; a token is disabled after enough. */
    failureCount: v.number(),
    disabledAt: v.optional(v.number()),
    /**
     * Why the token stopped being used: `signedOut`, `deviceNotRegistered`,
     * `failureLimit`, `accountDeleted`. Kept because "my phone stopped buzzing"
     * has four very different answers and only one of them is a bug.
     */
    disabledReason: v.optional(v.string()),
    lastSeenAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["expoPushToken"])
    .index("by_user_and_token", ["userId", "expoPushToken"]),

  /**
   * One row per notification PartyBooth decided to send.
   *
   * It exists because sending is **not** a mutation. A Convex mutation has no
   * `fetch`, so the decision ("this host should be told") and the delivery ("ask
   * exp.host") are necessarily two transactions with a scheduler between them,
   * and something has to survive the gap. This is that something: the mutation
   * writes `queued` rows, an action drains them, and the receipt check fifteen
   * minutes later finds the ticket it needs to ask about.
   *
   * It is also the only place a delivery failure is legible. A push that Expo
   * accepted and then silently dropped is invisible from every other angle.
   *
   * The **token is not stored here** — `deviceId` is. A table of notifications
   * is read far more often, and by more code, than a table of devices, and
   * duplicating the capability into it would mean every future query that
   * touched a notification touched a push token too.
   */
  pushNotifications: defineTable({
    userId: v.id("users"),
    deviceId: v.id("pushDevices"),
    category: pushCategory,
    /** The event this is about, when there is one. Drives the deep link. */
    eventId: v.optional(v.id("events")),

    title: v.string(),
    body: v.string(),
    /** Small routing payload the app reads to open the right screen. */
    data: v.optional(v.record(v.string(), v.string())),

    state: pushDeliveryState,
    /** Expo's ticket id, once it has accepted the message. */
    ticketId: v.optional(v.string()),
    /** The `details.error` Expo reported, on a ticket or on a receipt. */
    errorCode: v.optional(v.string()),
    error: v.optional(v.string()),
    attempts: v.number(),
    /**
     * The earliest a `queued` row may be sent again.
     *
     * Set while a row is backing off after a transport failure or a
     * `MessageRateExceeded` ticket — Expo's docs ask for exponential backoff on
     * network errors, 429s, 5xx responses and that ticket alike, and a retry
     * needs somewhere to remember how long to wait. Absent means "send it now",
     * which is what every row written before this existed means.
     */
    nextAttemptAt: v.optional(v.number()),

    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    /** When the receipt was read. Absent means the check has not run yet. */
    receiptCheckedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_state", ["state"])
    .index("by_state_and_createdAt", ["state", "createdAt"])
    // Receipt sweeps walk `sent` rows oldest-first *by send time*, because the
    // 24-hour receipt window is measured from the send and not from the queue.
    .index("by_state_and_sentAt", ["state", "sentAt"])
    .index("by_ticket", ["ticketId"])
    .index("by_device", ["deviceId"]),

  /**
   * The debounce memory for notifications — the same pattern as
   * `otpChallenges`, `joinAttempts` and `uploadAttempts`, and for the same
   * reason: Convex parallelises and recycles isolates, so a counter in memory is
   * not a counter.
   *
   * `key` is namespaced by category and subject (`pending:<eventId>:<userId>`,
   * `upload:<userId>:<captureId>`, `lifecycle:<eventId>:<userId>`) so one table
   * serves every category without them colliding. `lastValue` is
   * category-specific memory: the pending ping stores the queue depth it fired
   * at, the upload ping stores whether a failure was already announced.
   */
  notificationThrottles: defineTable({
    key: v.string(),
    lastSentAt: v.number(),
    lastValue: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /**
   * Invite-rotation budget, per event.
   *
   * Rotation is cheap to ask for and expensive to absorb: every rotation kills a
   * printed sign, and the revoke path also writes one audit row per guest it
   * removes. A host holding the button — or a script holding it — should not be
   * able to turn one party into ten thousand membership revocations, so the
   * ceiling lives here rather than in the UI. Same shape as `uploadAttempts`: it
   * counts **successes**, because the rotation itself is the scarce thing.
   */
  rotationAttempts: defineTable({
    key: v.string(),
    count: v.number(),
    windowStartedAt: v.number(),
    lastRotatedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

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
