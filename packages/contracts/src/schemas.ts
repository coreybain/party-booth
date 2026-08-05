import { z } from "zod";

import { eventCodeSchema } from "./codes";
import { hostSettableEventStateSchema, JOIN_WINDOW, launchModerationModeSchema } from "./events";
import { joinInputSchema } from "./join";
import {
  fromLibraryOf,
  mediaFileRoleSchema,
  mediaSourceOf,
  mediaSourceSchema,
  mediaStateSchema,
  mediaTypeSchema,
  moderationActionSchema,
  moderationDecisionSchema,
  reportReasonSchema,
  reportStatusSchema,
  VIDEO_MAX_DURATION_SECONDS,
} from "./media";
import { otpPurposeSchema } from "./otp";
import { expoPushTokenSchema, pushCategorySchema } from "./push";
import { eventRoleSchema } from "./roles";
import { storageRegionSchema } from "./storage";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** A Convex document id. Opaque to everything outside `packages/backend`. */
export const idSchema = z.string().min(1);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address." }));

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, { error: "Enter a name." })
  .max(60, { error: "Names are limited to 60 characters." });

export const eventNameSchema = z
  .string()
  .trim()
  .min(1, { error: "Give the event a name." })
  .max(80, { error: "Event names are limited to 80 characters." });

/** `#rrggbb`. Normalised to lower case so two hosts cannot pick "the same" colour twice. */
export const hexColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, { error: "Pick a colour." });

/**
 * IANA time-zone name. Validated structurally rather than against
 * `Intl.supportedValuesOf`, which is missing on some React Native engines —
 * the authoritative check happens server-side when the schedule is resolved.
 */
export const timeZoneSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/, {
    error: "Choose a time zone.",
  })
  .max(64);

/** Epoch milliseconds. Convex stores numbers; every timestamp in PartyBooth is one. */
export const timestampSchema = z.number().int().nonnegative();

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const requestOtpInputSchema = z.object({
  email: emailSchema,
  purpose: otpPurposeSchema,
});
export type RequestOtpInput = z.infer<typeof requestOtpInputSchema>;

export const verifyOtpInputSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .transform((value) => value.replace(/[\s-]/g, ""))
    .refine((value) => /^\d{6}$/.test(value), {
      error: "Enter the six-digit code we emailed you.",
    }),
  purpose: otpPurposeSchema,
});
export type VerifyOtpInput = z.infer<typeof verifyOtpInputSchema>;

export const updateProfileInputSchema = z.object({
  displayName: displayNameSchema,
});
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export const eventScheduleSchema = z
  .object({
    startsAt: timestampSchema,
    endsAt: timestampSchema.optional(),
    timeZone: timeZoneSchema,
  })
  .refine((value) => value.endsAt === undefined || value.endsAt > value.startsAt, {
    error: "The end time must be after the start time.",
    path: ["endsAt"],
  });
export type EventSchedule = z.infer<typeof eventScheduleSchema>;

export const createEventInputSchema = z
  .object({
    name: eventNameSchema,
    schedule: eventScheduleSchema,
    moderationMode: launchModerationModeSchema.default("manual"),
    accentColor: hexColorSchema.optional(),
    /** UploadThing key of the cover image. */
    coverKey: z.string().min(1).optional(),
    /**
     * Immutable once the first upload lands. Omitted means
     * `STORAGE_DEFAULT_REGION`; there is no picker UI at launch.
     */
    storageRegion: storageRegionSchema.optional(),
    /** Whether guests may pick existing photos from their library. */
    allowLibraryImport: z.boolean().default(true),
    /**
     * `scheduled` by default, not `draft`.
     *
     * A schedule is mandatory at creation, so the event *is* scheduled the moment
     * it exists, and `scheduled` is joinable — which is what makes printed
     * signage work before the doors open. `draft` stays available for a host who
     * wants to set up without the code going live yet.
     */
    initialState: z.enum(["draft", "scheduled"]).default("scheduled"),
    /** When a scheduled event starts accepting pre-event photos and video. */
    uploadStartsAt: timestampSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.uploadStartsAt === undefined) return;
    if (value.initialState !== "scheduled") {
      ctx.addIssue({
        code: "custom",
        message: "Pre-event uploads require a scheduled event.",
        path: ["uploadStartsAt"],
      });
    }
    if (value.uploadStartsAt >= value.schedule.startsAt) {
      ctx.addIssue({
        code: "custom",
        message: "Pre-event uploads must open before the event starts.",
        path: ["uploadStartsAt"],
      });
    }
    if (value.uploadStartsAt < value.schedule.startsAt - JOIN_WINDOW.opensBeforeStartMs) {
      ctx.addIssue({
        code: "custom",
        message: "Pre-event uploads cannot open more than 30 days before the event.",
        path: ["uploadStartsAt"],
      });
    }
  });
export type CreateEventInput = z.infer<typeof createEventInputSchema>;

export const updateEventInputSchema = z.object({
  eventId: idSchema,
  name: eventNameSchema.optional(),
  schedule: eventScheduleSchema.optional(),
  moderationMode: launchModerationModeSchema.optional(),
  accentColor: hexColorSchema.optional(),
  coverKey: z.string().min(1).optional(),
  allowLibraryImport: z.boolean().optional(),
});
export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;

/**
 * Move an event through its lifecycle. `deletionScheduled` is not offered —
 * see `HOST_SETTABLE_EVENT_STATES`.
 */
export const setEventStateInputSchema = z.object({
  eventId: idSchema,
  state: hostSettableEventStateSchema,
  reason: z.string().trim().max(280).optional(),
});
export type SetEventStateInput = z.infer<typeof setEventStateInputSchema>;

/** Start or end the party at the server's current time. */
export const setEventNowInputSchema = z.object({
  eventId: idSchema,
  action: z.enum(["start", "end"]),
});
export type SetEventNowInput = z.infer<typeof setEventNowInputSchema>;

/**
 * Which event the app's Camera and Host tabs are pointed at. `null` clears the
 * selection — a guest who has left every event is not "in" one.
 */
export const setActiveEventInputSchema = z.object({
  eventId: idSchema.nullable(),
});
export type SetActiveEventInput = z.infer<typeof setActiveEventInputSchema>;

export const rotateInviteInputSchema = z.object({
  eventId: idSchema,
  /** `false` revokes every membership created under the previous invite version. */
  keepExistingMemberships: z.boolean().default(true),
  /** Admin-only: rotate to a chosen code instead of a random one. */
  specificCode: eventCodeSchema.optional(),
  reason: z.string().trim().max(280).optional(),
});
export type RotateInviteInput = z.infer<typeof rotateInviteInputSchema>;

/* -------------------------------------------------------------------------- */
/* Joining                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A guest arrives either from a QR/universal link (token) or by typing the
 * six-digit code. Both land in the same audited, rate-limited mutation.
 *
 * The definition lives in `join.ts` alongside the throttle policy and the
 * result shape; this alias is what the apps already import.
 */
export const joinEventInputSchema = joinInputSchema;
export type JoinEventInput = z.infer<typeof joinEventInputSchema>;

/**
 * The pre-join preview: "is this really the party I think it is?".
 *
 * Answering it for a typed code is enumeration-sensitive, so the backend serves
 * this one from a **mutation** (throttled and audited exactly like a join) and
 * only the token form — 160 bits, unguessable — from a query.
 */
export const previewByCodeInputSchema = z.object({ code: eventCodeSchema });
export type PreviewByCodeInput = z.infer<typeof previewByCodeInputSchema>;

export const inviteCohostInputSchema = z.object({
  eventId: idSchema,
  email: emailSchema,
});
export type InviteCohostInput = z.infer<typeof inviteCohostInputSchema>;

/** Withdraw an invitation that has not been accepted yet. */
export const revokeCohostInviteInputSchema = z.object({
  invitationId: idSchema,
  reason: z.string().trim().max(280).optional(),
});
export type RevokeCohostInviteInput = z.infer<typeof revokeCohostInviteInputSchema>;

/**
 * Demote somebody who **is** a co-host.
 *
 * Addressed by user rather than by membership id because the owner's console
 * lists people, not rows — and because the same address may have both a pending
 * invitation and a live membership, in which case removing the co-host has to
 * take the invitation with it or the next sign-in re-grants the seat.
 */
export const removeCohostInputSchema = z.object({
  eventId: idSchema,
  userId: idSchema,
  reason: z.string().trim().max(280).optional(),
});
export type RemoveCohostInput = z.infer<typeof removeCohostInputSchema>;

export const revokeMembershipInputSchema = z.object({
  membershipId: idSchema,
  reason: z.string().trim().max(280).optional(),
});
export type RevokeMembershipInput = z.infer<typeof revokeMembershipInputSchema>;

export const membershipRoleSchema = eventRoleSchema;

export const MEMBERSHIP_STATUSES = ["active", "revoked", "left"] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * A membership as a client sees it. No `invitedEmail` — who else was invited by
 * address is host information, not guest information.
 */
export const membershipSchema = z.object({
  id: idSchema,
  eventId: idSchema,
  userId: idSchema,
  role: membershipRoleSchema,
  status: membershipStatusSchema,
  /** The invite version that admitted them — what rotation revokes against. */
  inviteVersionId: idSchema.optional(),
  joinedAt: timestampSchema,
});
export type Membership = z.infer<typeof membershipSchema>;

/* -------------------------------------------------------------------------- */
/* Verified-email matching                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apple private-relay users cannot receive an organiser or co-host invitation
 * at the address their account carries, so they prove a second one with the
 * same six-digit OTP infrastructure and matching then runs against both.
 */
export const requestEmailVerificationInputSchema = z.object({ email: emailSchema });
export type RequestEmailVerificationInput = z.infer<typeof requestEmailVerificationInputSchema>;

export const confirmEmailVerificationInputSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .transform((value) => value.replace(/[\s-]/g, ""))
    .refine((value) => /^\d{6}$/.test(value), {
      error: "Enter the six-digit code we emailed you.",
    }),
});
export type ConfirmEmailVerificationInput = z.infer<typeof confirmEmailVerificationInputSchema>;

/* -------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a client asks Convex for before it may talk to UploadThing. Everything
 * the middleware needs to validate the upload is in here, and the grant that
 * comes back is short-lived and single-use (Sprint 3).
 */
export const captureIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, {
    error: "captureId may only contain letters, numbers, hyphens and underscores.",
  });

/** Lower-case hex SHA-256. The one shape a checksum is allowed to have. */
export const checksumSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "checksum must be lower-case hex SHA-256" });

export const uploadGrantRequestSchema = z
  .object({
    eventId: idSchema,
    /** Client-generated, stable across retries — this is what makes uploads idempotent. */
    captureId: captureIdSchema,
    mediaType: mediaTypeSchema,
    /**
     * Which artefact of the capture this grant is for — the submitted frame, or
     * one of the derivatives the clients produce alongside it (ADR 0008).
     *
     * Defaulted, so every Sprint-3 call site keeps meaning exactly what it meant.
     */
    fileRole: mediaFileRoleSchema.default("original"),
    byteSize: z.number().int().positive(),
    mimeType: z.string().min(1).max(128),
    /**
     * SHA-256 of the file, lower-case hex.
     *
     * Carried back through the upload ticket and compared in `matchesGrant`, so
     * a completion whose body is not the one the grant was minted against is
     * refused and the object deleted. Both sides of that comparison originate on
     * the client, so it catches an *inconsistent* client rather than a
     * determined one — the cap that a determined client cannot walk around is
     * `byteSize`, which the middleware now checks against the grant before any
     * bytes move.
     */
    checksum: checksumSchema,
    durationSeconds: z.number().positive().max(VIDEO_MAX_DURATION_SECONDS).optional(),
    capturedAt: timestampSchema.optional(),
    /**
     * Where the file came from. `fromLibrary` is the older spelling and is what
     * the `media` table stores; both are accepted on the wire and reconciled
     * below so they can never disagree — see `mediaSourceOf` in `media.ts`.
     */
    mediaSource: mediaSourceSchema.optional(),
    fromLibrary: z.boolean().optional(),
    /**
     * The client's claim that it **re-encoded** the frame, dropping whatever
     * container the camera wrote — the chosen metadata-stripping strategy (ADR
     * 0004). Required to be `true` for a derivative; recorded for an original.
     */
    sourceMetadataStripped: z.boolean().optional(),
    /**
     * The client's separate claim that the file **carries no location fix**.
     *
     * Implied by the re-encode for a photograph and *not* implied for a video,
     * which no client can transcode — see `MetadataClaim` in `./media`. Absent
     * means "same as the re-encode claim", which is what every pre-Sprint-4
     * caller meant, so this is additive and no stored row changes meaning.
     *
     * This is the half the read path consults: an original that cannot promise
     * it is location-free is served to its submitter and the hosts and to nobody
     * else.
     */
    sourceCarriesNoLocation: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.mediaSource === undefined ||
      value.fromLibrary === undefined ||
      fromLibraryOf(value.mediaSource) === value.fromLibrary,
    { error: "mediaSource and fromLibrary disagree.", path: ["mediaSource"] },
  )
  .transform((value) => {
    const fromLibrary =
      value.mediaSource === undefined
        ? (value.fromLibrary ?? false)
        : fromLibraryOf(value.mediaSource);
    return { ...value, fromLibrary, mediaSource: mediaSourceOf(fromLibrary) };
  })
  .refine(
    (value) =>
      value.mediaType !== "video" ||
      // A poster is a still frame lifted out of the video; it has no duration of
      // its own, and demanding one would refuse every legitimate thumbnail.
      value.fileRole === "poster" ||
      value.durationSeconds !== undefined,
    {
      error: "durationSeconds is required for videos.",
      path: ["durationSeconds"],
    },
  );
export type UploadGrantRequest = z.infer<typeof uploadGrantRequestSchema>;

/*
 * There is no `uploadGrantSchema` here. A Sprint-1 placeholder of that name
 * described a grant with a `token` field; the grant Sprint 3 actually issues is
 * `IssuedGrant` in `./upload`, its capability is called `secret`, and it is
 * re-parsed by `parseGrantResult`. Two shapes for one concept is how a client
 * ends up reading a field the server never sends, so the placeholder is gone
 * rather than kept in step.
 */

/**
 * What the client sends once its own upload finished, which is **not** the same
 * event as the provider's completion callback and may arrive either side of it.
 * It carries no file facts at all: the client is not a source of truth about
 * what landed in storage, only about the fact that it stopped waiting.
 */
export const confirmUploadInputSchema = z.object({
  secret: z.string().min(16),
});
export type ConfirmUploadInput = z.infer<typeof confirmUploadInputSchema>;

/**
 * What the UploadThing route handler in `apps/web` sends when a file is stored.
 *
 * `secret` is the grant; `callbackSecret` is the shared secret that proves the
 * call came from our own route handler rather than from a guest replaying the
 * grant they were legitimately given. Both are required: the grant says *which*
 * upload, the callback secret says *who is allowed to say so*.
 */
export const completeUploadInputSchema = z.object({
  secret: z.string().min(16),
  fileKey: z.string().min(1).max(256),
  byteSize: z.number().int().positive(),
  mimeType: z.string().min(1).max(128).optional(),
  checksum: checksumSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
});
export type CompleteUploadInput = z.infer<typeof completeUploadInputSchema>;

export const withdrawMediaInputSchema = z.object({
  mediaId: idSchema,
  reason: z.string().trim().max(280).optional(),
});
export type WithdrawMediaInput = z.infer<typeof withdrawMediaInputSchema>;

export const listEventMediaInputSchema = z.object({
  eventId: idSchema,
  /** Absent means "everything this role may see". */
  states: z.array(mediaStateSchema).min(1).max(5).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ListEventMediaInput = z.infer<typeof listEventMediaInputSchema>;

/* -------------------------------------------------------------------------- */
/* Moderation                                                                 */
/* -------------------------------------------------------------------------- */

export const moderateMediaInputSchema = z.object({
  mediaIds: z.array(idSchema).min(1).max(200),
  decision: moderationDecisionSchema,
  reason: z.string().trim().max(280).optional(),
});
export type ModerateMediaInput = z.infer<typeof moderateMediaInputSchema>;

/**
 * One moderation button press, or a bulk selection of them.
 *
 * `mediaIds` rather than `mediaId` even for a single item, because the grid's
 * single-tap and its "select all 40 and approve" are the same operation with a
 * different array length — and writing them as two mutations is how the two
 * paths end up disagreeing about idempotence at 1am.
 *
 * The ceiling is 200: past that a host is not moderating, they are choosing
 * `automatic` mode, and an unbounded batch is an unbounded transaction.
 */
export const moderationActionInputSchema = z.object({
  eventId: idSchema,
  mediaIds: z.array(idSchema).min(1).max(200),
  action: moderationActionSchema,
  reason: z.string().trim().max(280).optional(),
});
export type ModerationActionInput = z.infer<typeof moderationActionInputSchema>;

export const reportMediaInputSchema = z.object({
  mediaId: idSchema,
  reason: reportReasonSchema,
  details: z.string().trim().max(500).optional(),
});
export type ReportMediaInput = z.infer<typeof reportMediaInputSchema>;

export const resolveReportInputSchema = z.object({
  reportId: idSchema,
  status: reportStatusSchema.exclude(["open"]),
  reason: z.string().trim().max(280).optional(),
});
export type ResolveReportInput = z.infer<typeof resolveReportInputSchema>;

/**
 * Block another guest.
 *
 * `eventId` is where the block was made, not what it is scoped to: a block is
 * per-account and applies everywhere, which is what App Review's "block abusive
 * users" means. The event is recorded so an audit row can say where it happened.
 */
export const blockUserInputSchema = z.object({
  eventId: idSchema,
  userId: idSchema,
});
export type BlockUserInput = z.infer<typeof blockUserInputSchema>;

export const unblockUserInputSchema = z.object({
  userId: idSchema,
});
export type UnblockUserInput = z.infer<typeof unblockUserInputSchema>;

/* -------------------------------------------------------------------------- */
/* Organiser home and slideshow                                               */
/* -------------------------------------------------------------------------- */

export const eventStatsInputSchema = z.object({
  eventId: idSchema,
  /** How many recent submissions to include. */
  recentLimit: z.number().int().positive().max(50).optional(),
  /** How many contributors to rank. */
  contributorLimit: z.number().int().positive().max(50).optional(),
});
export type EventStatsInput = z.infer<typeof eventStatsInputSchema>;

/**
 * A page of the slideshow.
 *
 * `after` is a {@link encodeMediaCursor} string. A slideshow left running all
 * night re-runs its subscription every time a photo is approved, so the client
 * asks for "everything after the last one I have" and appends, rather than
 * re-reading the whole party and re-minting a signed URL per item per approval.
 */
export const slideshowInputSchema = z.object({
  eventId: idSchema,
  after: z.string().max(96).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type SlideshowInput = z.infer<typeof slideshowInputSchema>;

/* -------------------------------------------------------------------------- */
/* Account deletion (App Review)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Apple requires account deletion to be reachable from inside the app. The
 * account moves to `deletionScheduled` immediately and loses access; the 30-day
 * purge worker is post-launch (PLAN.md).
 */
export const requestAccountDeletionInputSchema = z.object({
  reason: z.string().trim().max(280).optional(),
});
export type RequestAccountDeletionInput = z.infer<typeof requestAccountDeletionInputSchema>;

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export const pushPlatformSchema = z.enum(PUSH_PLATFORMS);
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const registerPushDeviceInputSchema = z.object({
  /**
   * Expo push token, e.g. `ExponentPushToken[xxxxxxxx]`.
   *
   * Validated against the real shape rather than as "a longish string": a
   * simulator, a denied permission prompt or an FCM token all produce something
   * that passes a length check and then fails on every send forever.
   */
  expoPushToken: expoPushTokenSchema,
  platform: pushPlatformSchema,
  deviceName: z.string().trim().max(120).optional(),
});
export type RegisterPushDeviceInput = z.infer<typeof registerPushDeviceInputSchema>;

/**
 * Retire one device's token — sign-out, or the app being told the token rotated.
 *
 * By token rather than by device id, because the client holding the token is the
 * one signing out and it does not know our row ids.
 */
export const unregisterPushDeviceInputSchema = z.object({
  expoPushToken: expoPushTokenSchema,
});
export type UnregisterPushDeviceInput = z.infer<typeof unregisterPushDeviceInputSchema>;

/**
 * Per-category opt-out, plus the host's pending threshold.
 *
 * Both fields are optional so a settings screen can send the one toggle the user
 * moved rather than the whole object, which is what stops two phones racing each
 * other into overwriting a preference neither of them changed.
 */
export const updateNotificationPreferencesInputSchema = z.object({
  optOut: z.array(pushCategorySchema).max(8).optional(),
  pendingThreshold: z.number().int().min(1).max(100).optional(),
});
export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesInputSchema
>;

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The reason string every admin-console mutation carries.
 *
 * One definition, because PLAN.md's rule is "**every** action" and a per-schema
 * `z.string().optional()` is how one of them ends up being the exception. Three
 * characters is a deliberately low bar — it exists to stop an empty submit, not
 * to grade prose — and the audit writer refuses a blank one regardless of what a
 * caller sends, so this is the friendly half of a check that also exists in the
 * one place a client cannot skip.
 */
export const adminReasonSchema = z
  .string()
  .trim()
  .min(3, { error: "Give a reason — it goes in the audit log." })
  .max(280, { error: "Reasons are limited to 280 characters." });

export const GUEST_MEMBERSHIP_ACTIONS = ["remove", "ban"] as const;
export const guestMembershipActionSchema = z.enum(GUEST_MEMBERSHIP_ACTIONS);
export type GuestMembershipAction = (typeof GUEST_MEMBERSHIP_ACTIONS)[number];

/**
 * Eject one guest from an event.
 *
 * Removal permits a fresh scan of the current credential; banning does not.
 * Both require an audit reason because the distinction must survive the UI.
 */
export const guestMembershipActionInputSchema = z.object({
  eventId: idSchema,
  userId: idSchema,
  action: guestMembershipActionSchema,
  reason: adminReasonSchema,
});
export type GuestMembershipActionInput = z.infer<typeof guestMembershipActionInputSchema>;

/** Whether this guest's future uploads bypass manual moderation. */
export const guestAutoApproveInputSchema = z.object({
  eventId: idSchema,
  userId: idSchema,
  enabled: z.boolean(),
});
export type GuestAutoApproveInput = z.infer<typeof guestAutoApproveInputSchema>;

export const inviteOrganiserInputSchema = z.object({
  email: emailSchema,
  note: z.string().trim().max(280).optional(),
  reason: adminReasonSchema,
});
export type InviteOrganiserInput = z.infer<typeof inviteOrganiserInputSchema>;

/**
 * Every destructive admin action carries a reason. The console must not let one
 * through without it — see `auditActionRequiresReason`.
 */
export const adminAccountActionInputSchema = z.object({
  userId: idSchema,
  reason: adminReasonSchema,
});
export type AdminAccountActionInput = z.infer<typeof adminAccountActionInputSchema>;

/** Schedule or restore the deletion of an event. */
export const adminEventActionInputSchema = z.object({
  eventId: idSchema,
  reason: adminReasonSchema,
});
export type AdminEventActionInput = z.infer<typeof adminEventActionInputSchema>;

export const ADMIN_ROTATION_MODES = ["random", "specific"] as const;
export const adminRotationModeSchema = z.enum(ADMIN_ROTATION_MODES);
export type AdminRotationMode = (typeof ADMIN_ROTATION_MODES)[number];

/**
 * Rotate an event's join code from the console.
 *
 * `specific` is first on PLAN.md's cut list, which is why the mode is explicit
 * rather than inferred from the presence of `specificCode`: a console that has
 * had the feature cut sends `random` and a backend that has had it cut refuses
 * `specific`, and neither of them has to guess what an absent field meant.
 */
export const adminRotateCodeInputSchema = z
  .object({
    eventId: idSchema,
    mode: adminRotationModeSchema.default("random"),
    specificCode: eventCodeSchema.optional(),
    keepExistingMemberships: z.boolean().default(true),
    reason: adminReasonSchema,
  })
  .refine((value) => value.mode !== "specific" || value.specificCode !== undefined, {
    error: "Choosing a specific code means supplying one.",
    path: ["specificCode"],
  });
export type AdminRotateCodeInput = z.infer<typeof adminRotateCodeInputSchema>;

export const adminRevokeMembershipInputSchema = z.object({
  membershipId: idSchema,
  reason: adminReasonSchema,
});
export type AdminRevokeMembershipInput = z.infer<typeof adminRevokeMembershipInputSchema>;

/** Paging and filtering for the console's two list views. */
export const adminListInputSchema = z.object({
  /** Matched against email and display name (accounts) or name (events). */
  search: z.string().trim().max(120).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type AdminListInput = z.infer<typeof adminListInputSchema>;
