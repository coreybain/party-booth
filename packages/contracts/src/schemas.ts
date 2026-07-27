import { z } from "zod";

import { eventCodeSchema, inviteTokenSchema } from "./codes";
import { launchModerationModeSchema } from "./events";
import {
  mediaTypeSchema,
  moderationDecisionSchema,
  reportReasonSchema,
  VIDEO_MAX_DURATION_SECONDS,
} from "./media";
import { otpPurposeSchema } from "./otp";
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
  /** UploadThing key of the confirmed avatar, if the user set one. */
  avatarKey: z.string().min(1).optional(),
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

export const createEventInputSchema = z.object({
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
 */
export const joinEventInputSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("token"), token: inviteTokenSchema }),
  z.object({ via: z.literal("code"), code: eventCodeSchema }),
]);
export type JoinEventInput = z.infer<typeof joinEventInputSchema>;

export const inviteCohostInputSchema = z.object({
  eventId: idSchema,
  email: emailSchema,
});
export type InviteCohostInput = z.infer<typeof inviteCohostInputSchema>;

export const revokeMembershipInputSchema = z.object({
  membershipId: idSchema,
  reason: z.string().trim().max(280).optional(),
});
export type RevokeMembershipInput = z.infer<typeof revokeMembershipInputSchema>;

export const membershipRoleSchema = eventRoleSchema;

/* -------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a client asks Convex for before it may talk to UploadThing. Everything
 * the middleware needs to validate the upload is in here, and the grant that
 * comes back is short-lived and single-use (Sprint 3).
 */
export const uploadGrantRequestSchema = z
  .object({
    eventId: idSchema,
    /** Client-generated, stable across retries — this is what makes uploads idempotent. */
    captureId: z.string().min(8).max(64),
    mediaType: mediaTypeSchema,
    byteSize: z.number().int().positive(),
    mimeType: z.string().min(1).max(128),
    /** SHA-256 of the file, lower-case hex. Lets the callback reject a swapped body. */
    checksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/, { error: "checksum must be lower-case hex SHA-256" }),
    durationSeconds: z.number().positive().max(VIDEO_MAX_DURATION_SECONDS).optional(),
    capturedAt: timestampSchema.optional(),
    /** `true` when the file came from the library rather than the camera. */
    fromLibrary: z.boolean().default(false),
  })
  .refine((value) => value.mediaType !== "video" || value.durationSeconds !== undefined, {
    error: "durationSeconds is required for videos.",
    path: ["durationSeconds"],
  });
export type UploadGrantRequest = z.infer<typeof uploadGrantRequestSchema>;

export const uploadGrantSchema = z.object({
  grantId: idSchema,
  /** Opaque secret the upload route exchanges for permission to store the file. */
  token: z.string().min(16),
  eventId: idSchema,
  captureId: z.string(),
  storageRegion: storageRegionSchema,
  expiresAt: timestampSchema,
});
export type UploadGrant = z.infer<typeof uploadGrantSchema>;

/* -------------------------------------------------------------------------- */
/* Moderation                                                                 */
/* -------------------------------------------------------------------------- */

export const moderateMediaInputSchema = z.object({
  mediaIds: z.array(idSchema).min(1).max(200),
  decision: moderationDecisionSchema,
  reason: z.string().trim().max(280).optional(),
});
export type ModerateMediaInput = z.infer<typeof moderateMediaInputSchema>;

export const reportMediaInputSchema = z.object({
  mediaId: idSchema,
  reason: reportReasonSchema,
  details: z.string().trim().max(500).optional(),
});
export type ReportMediaInput = z.infer<typeof reportMediaInputSchema>;

export const blockUserInputSchema = z.object({
  eventId: idSchema,
  userId: idSchema,
});
export type BlockUserInput = z.infer<typeof blockUserInputSchema>;

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export const pushPlatformSchema = z.enum(PUSH_PLATFORMS);
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const registerPushDeviceInputSchema = z.object({
  /** Expo push token, e.g. `ExponentPushToken[xxxxxxxx]`. */
  expoPushToken: z.string().min(10).max(256),
  platform: pushPlatformSchema,
  deviceName: z.string().trim().max(120).optional(),
});
export type RegisterPushDeviceInput = z.infer<typeof registerPushDeviceInputSchema>;

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

export const inviteOrganiserInputSchema = z.object({
  email: emailSchema,
  note: z.string().trim().max(280).optional(),
});
export type InviteOrganiserInput = z.infer<typeof inviteOrganiserInputSchema>;

/**
 * Every destructive admin action carries a reason. The console must not let one
 * through without it — see `auditActionRequiresReason`.
 */
export const adminAccountActionInputSchema = z.object({
  userId: idSchema,
  reason: z.string().trim().min(3, { error: "Give a reason — it goes in the audit log." }).max(280),
});
export type AdminAccountActionInput = z.infer<typeof adminAccountActionInputSchema>;
