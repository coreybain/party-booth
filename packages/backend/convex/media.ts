import {
  canSeeMedia,
  isDerivativeRole,
  isFileRoleAllowed,
  MEDIA_STATES,
  mediaStateMachine,
  metadataClaimOf,
  VIDEO_MAX_DURATION_SECONDS,
  type DerivativeFileRole,
  type MediaState,
} from "@partybooth/contracts/media";
import { DENIAL_MESSAGES, explainCan } from "@partybooth/contracts/permissions";
import { hasAcceptedTerms } from "@partybooth/contracts/terms";
import { isHostRole, type Role } from "@partybooth/contracts/roles";
import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import {
  judgeVideoDuration,
  readIsoBmffDuration,
  VIDEO_DURATION_VERDICTS,
  type VideoDurationVerdict,
} from "@partybooth/contracts/video";
import {
  accountGrantKey,
  checkGrantEligibility,
  describesSameFile,
  fileRoleOf,
  grantRejected,
  grantSizeCap,
  grantThrottled,
  matchesGrant,
  normaliseMime,
  type CaptureFileFacts,
  type GrantResult,
  type UploadCompletionOutcome,
  type UploadRejectionReason,
} from "@partybooth/contracts/upload";
import { inviteTokenSchema, normalizeInviteToken } from "@partybooth/contracts/codes";
import { eventAcceptsUploads, isViewableEventState } from "@partybooth/contracts/events";
import {
  completeUploadInputSchema,
  confirmUploadInputSchema,
  listEventMediaInputSchema,
  uploadGrantRequestSchema,
  withdrawMediaInputSchema,
} from "@partybooth/contracts/schemas";
import { envOptional, serverEnv } from "@partybooth/env/server";
import {
  paginationOptsValidator,
  paginationResultValidator,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { isHiddenByBlock, loadBlockedUserIds } from "./lib/blocks";
import { forbidden, notFound } from "./lib/errors";
import {
  requireActiveUser,
  requireEventActor,
  requireEventActorFor,
  requirePermission,
  toPermissionActor,
  type EventActor,
} from "./lib/guards";
import { parseInput } from "./lib/input";
import { eventFreeze, eventIsUsable } from "./lib/lock";
import {
  applyCountChange,
  attachDerivative,
  ensureMediaRow,
  findMediaByCapture,
  mediaViewValidator,
  projectMedia,
  projectPublicMedia,
  publicMediaViewValidator,
  settleAfterProcessing,
  storageKeysOf,
  type MediaView,
} from "./lib/media";
import { reportError } from "./lib/sentry";
import { resolveStorageAdapter } from "./lib/storage";
import { createStoragePurgeJob } from "./lib/storage_purge";
import { requireUploadCallbackSecret } from "./lib/upload_callback";
import {
  consumeGrant,
  expireGrantsForCapture,
  issueGrant,
  linkGrantToMedia,
  startGrant,
} from "./lib/upload_grants";
import { checkUploadThrottle, recordGrantIssued } from "./lib/upload_throttle";
import {
  literalUnion,
  mediaFileRole,
  mediaState,
  mediaType,
  storageRegion,
} from "./lib/validators";

/**
 * The upload spine.
 *
 * Four entry points, in the order a photo travels through them:
 *
 * 1. {@link requestUploadGrant} — the guest asks for permission to send one
 *    exact file. Permission-checked, size-capped, throttled, audited, and
 *    answered with a two-minute single-use secret.
 * 2. {@link confirmUpload} — authenticated edge preflight reserves the grant;
 *    the phone may call it later to reconcile the row after transport.
 * 3. {@link completeUpload} — the UploadThing route handler in `apps/web` says
 *    what actually landed. Spends the grant, attaches the file, and moves the
 *    item to `pending` or `approved` per the event's moderation mode.
 * 4. {@link withdraw} — the submitter changes their mind. Permanent.
 *
 * Steps 2 and 3 **arrive in either order and more than once**, on a network that
 * drops packets in a room full of people. Everything here is therefore written
 * to reconcile rather than to assume, keyed on `(eventId, captureId)`, and every
 * repeat is a no-op that reports success — a callback that returns an error is a
 * callback the provider retries forever.
 *
 * Two rules that are easy to lose and expensive to lose:
 *
 * - **Refusals on the counting paths are values, not exceptions.** A Convex
 *   mutation that throws rolls its own writes back, so a handler that charges a
 *   throttle and then throws has charged nothing. `requestUploadGrant` returns
 *   `{ outcome: "rejected" }`; see `packages/backend/README.md`.
 * - **No read path returns a file key.** Keys name objects directly and private
 *   ACLs are the only thing between a key and the photo. Reads return
 *   short-lived signed URLs from the storage adapter, minted after the
 *   permission check.
 */

/* -------------------------------------------------------------------------- */
/* Scheduled functions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `_generated/api.d.ts` is the **generic** fallback (`AnyApi`) until codegen can
 * reach a deployment, so `ctx.scheduler.runAfter(0, internal.media.x, …)` would
 * be `any` on both the reference and its arguments. Naming the two scheduled
 * functions once, here, is the same cast `auth.ts` and `emails.ts` make and for
 * the same reason: a renamed argument becomes a compile error in one place
 * instead of a failed action on party night. It becomes a no-op once
 * `bunx convex dev` has produced the precise api.
 */
const mediaFunctions = internal.media as unknown as {
  purgeStoredFile: FunctionReference<
    "action",
    "internal",
    {
      region: Doc<"media">["storageRegion"];
      keys: string[];
      mediaId?: Id<"media">;
      purgeJobId?: Id<"storagePurgeJobs">;
      attempt?: number;
    },
    null
  >;
  markStoragePurged: FunctionReference<
    "mutation",
    "internal",
    { mediaId: Id<"media">; deleted: number; requested?: number },
    null
  >;
  markStoragePurgeFailed: FunctionReference<
    "mutation",
    "internal",
    { mediaId: Id<"media">; attempts: number; requested: number; deleted: number },
    null
  >;
  markGenericStoragePurged: FunctionReference<
    "mutation",
    "internal",
    { purgeJobId: Id<"storagePurgeJobs">; attempts: number; requested: number; deleted: number },
    null
  >;
  markGenericStoragePurgeAttempt: FunctionReference<
    "mutation",
    "internal",
    { purgeJobId: Id<"storagePurgeJobs">; attempts: number; reason: string },
    null
  >;
  markGenericStoragePurgeFailed: FunctionReference<
    "mutation",
    "internal",
    {
      purgeJobId: Id<"storagePurgeJobs">;
      attempts: number;
      requested: number;
      deleted: number;
      reason: string;
    },
    null
  >;
  verifyVideoDuration: FunctionReference<"action", "internal", { mediaId: Id<"media"> }, null>;
  mediaForDurationProbe: FunctionReference<
    "query",
    "internal",
    { mediaId: Id<"media"> },
    { storageKey?: string; storageRegion: Doc<"media">["storageRegion"]; state: MediaState } | null
  >;
  recordVideoDurationVerdict: FunctionReference<
    "mutation",
    "internal",
    { mediaId: Id<"media">; verdict: VideoDurationVerdict; measuredSeconds?: number },
    null
  >;
};

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

const grantResultValidator = v.union(
  v.object({
    outcome: v.literal("granted"),
    grantId: v.id("uploadGrants"),
    secret: v.string(),
    eventId: v.id("events"),
    captureId: v.string(),
    mediaType,
    /**
     * Always sent, declared optional — the same shape `IssuedGrant` has, for the
     * same reason: a client build that predates derivatives parses grants with
     * `mediaFileRoleSchema.default("original")` and must not start failing
     * because a field it ignores became mandatory.
     */
    fileRole: v.optional(mediaFileRole),
    mediaSource: v.union(v.literal("capture"), v.literal("library")),
    storageRegion,
    byteSize: v.number(),
    maxBytes: v.number(),
    expiresAt: v.number(),
  }),
  v.object({
    outcome: v.literal("alreadyUploaded"),
    mediaId: v.id("media"),
    state: v.union(v.literal("pending"), v.literal("approved"), v.literal("declined")),
  }),
  v.object({ outcome: v.literal("rejected"), reason: v.string(), message: v.string() }),
  v.object({
    outcome: v.literal("throttled"),
    message: v.string(),
    retryAfterMs: v.number(),
  }),
);

/* -------------------------------------------------------------------------- */
/* 1. Grants                                                                  */
/* -------------------------------------------------------------------------- */

export const requestUploadGrant = mutation({
  args: {
    eventId: v.id("events"),
    captureId: v.string(),
    mediaType,
    /**
     * Which artefact of the capture. Absent means `original`, which is what
     * every Sprint-3 client sends and means.
     */
    fileRole: v.optional(mediaFileRole),
    byteSize: v.number(),
    mimeType: v.string(),
    checksum: v.string(),
    durationSeconds: v.optional(v.number()),
    capturedAt: v.optional(v.number()),
    mediaSource: v.optional(v.union(v.literal("capture"), v.literal("library"))),
    fromLibrary: v.optional(v.boolean()),
    /** The client's claim that it **re-encoded** the bytes before uploading. */
    sourceMetadataStripped: v.optional(v.boolean()),
    /**
     * The client's separate claim that the file **carries no location**.
     *
     * Absent means "same as the re-encode claim", so a client that has not
     * shipped the split sends exactly what it sent before and means exactly what
     * it meant. See `MetadataClaim` in `@partybooth/contracts/media`.
     */
    sourceCarriesNoLocation: v.optional(v.boolean()),
    challengeAssignmentId: v.optional(v.id("photoChallengeAssignments")),
  },
  returns: grantResultValidator,
  handler: async (
    ctx,
    args,
  ): Promise<GrantResult<Id<"uploadGrants">, Id<"events">, Id<"media">>> => {
    // `requireEventActor` hides an event this account has no relationship with
    // behind `notFound`, so an event id cannot be probed from here either.
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot upload right now.");
    }

    const input = parseInput(uploadGrantRequestSchema, args);
    const now = Date.now();

    /*
     * Reconcile a success before re-evaluating mutable upload policy.
     *
     * This branch does not authorise new bytes. It proves that this active
     * authenticated member owns an already-settled row for the exact same file,
     * then returns its id. Consequently a queue resumed after an app pause can
     * learn that its earlier callback succeeded even if the host has since
     * paused/archived the event, disabled library imports, or the current terms
     * version has changed. Running those gates first manufactured a permanent
     * failure for a file which was already safely stored.
     */
    const requested: CaptureFileFacts = {
      mediaType: input.mediaType,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      checksum: input.checksum,
      durationSeconds: input.durationSeconds,
    };
    const existing = await findMediaByCapture(ctx, actor.event._id, input.captureId);
    const alreadyUploaded = isDerivativeRole(input.fileRole)
      ? undefined
      : reconcileAlreadyUploaded(actor.user._id, existing, requested);
    if (alreadyUploaded !== undefined) return alreadyUploaded;

    /*
     * Terms before content.
     *
     * Play's UGC policy asks for accepted terms defining and prohibiting
     * objectionable content *before* a user creates any, and Apple's guideline
     * 1.2 reads the same way. Acceptance is taken at onboarding, so in practice
     * this catches the two cases onboarding cannot: an account that predates the
     * terms, and every account after `TERMS_VERSION` moves.
     *
     * A value rather than an exception, like every other refusal on this path —
     * the throttle write above it has to commit — and audited, because "nobody
     * could upload for twenty minutes" has to be answerable afterwards.
     */
    if (!hasAcceptedTerms(actor.user)) {
      return await rejectGrant(ctx, {
        actor,
        captureId: input.captureId,
        reason: "termsNotAccepted",
        now,
      });
    }

    // The role gate first — a global admin has no `media.*` capability at all —
    // but `explainCan` rather than `requirePermission`, for the same reason
    // `events.create` uses it: a refusal because the *event* is paused is an
    // expected outcome of a normal flow, not an exception, and it has to come
    // back as a value so the throttle write above it commits. Only a refusal
    // about the actor throws.
    const decision = explainCan(toPermissionActor(actor.user, actor.role), "media.upload", {
      kind: "media",
      state: "processing",
      isOwn: true,
      event: {
        state: actor.event.state,
        uploadsOpen: eventAcceptsUploads(actor.event, now),
      },
    });
    if (!decision.allowed && decision.reason !== "resourceState") {
      throw forbidden(DENIAL_MESSAGES[decision.reason]);
    }

    // …then the domain gate, which knows *why* the state refused and can say
    // so. Library imports and size caps both live here, in one pure function
    // shared with the client.
    const eligibility = checkGrantEligibility({
      event: {
        state: actor.event.state,
        allowLibraryImport: actor.event.allowLibraryImport,
        ...(actor.event.uploadStartsAt === undefined
          ? {}
          : { uploadStartsAt: actor.event.uploadStartsAt }),
      },
      now,
      mediaSource: input.mediaSource,
      file: {
        mediaType: input.mediaType,
        // The role selects the cap and the accepted formats: a preview is held
        // to two megabytes where its original gets twenty.
        fileRole: input.fileRole,
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        durationSeconds: input.durationSeconds,
      },
      sourceMetadataStripped: input.sourceMetadataStripped,
      sourceCarriesNoLocation: input.sourceCarriesNoLocation,
    });
    if (!eligibility.ok) {
      return await rejectGrant(ctx, {
        actor,
        captureId: input.captureId,
        reason: eligibility.reason,
        now,
      });
    }

    const refusal = isDerivativeRole(input.fileRole)
      ? await checkDerivativeGrant(ctx, {
          userId: actor.user._id,
          eventId: actor.event._id,
          captureId: input.captureId,
          role: input.fileRole,
          mediaType: input.mediaType,
          checksum: input.checksum,
          existing,
        })
      : checkOriginalGrant(actor.user._id, existing, requested);

    if (refusal !== undefined) {
      return await rejectGrant(ctx, {
        actor,
        captureId: input.captureId,
        reason: refusal,
        now,
      });
    }

    const challenge = await trustedChallengeForGrant(ctx, {
      assignmentId: input.challengeAssignmentId,
      eventId: actor.event._id,
      userId: actor.user._id,
      captureId: input.captureId,
    });

    const throttleKey = accountGrantKey(actor.user._id);
    const throttle = await checkUploadThrottle(ctx, throttleKey, now);
    if (!throttle.allowed) {
      // Deliberately *not* audited as a rejection: a throttled request is a fact
      // about the caller's own recent history, and one row per over-eager
      // auto-send would bury the rejections that matter.
      return grantThrottled(throttle.retryAfterMs);
    }

    const issued = await issueGrant(ctx, {
      eventId: actor.event._id,
      userId: actor.user._id,
      captureId: input.captureId,
      mediaType: input.mediaType,
      fileRole: input.fileRole,
      fromLibrary: input.fromLibrary,
      // From the **event row**, never from the environment: files never migrate,
      // so the region an event was created in is the region it keeps (ADR 0002).
      storageRegion: actor.event.storageRegion,
      byteSize: input.byteSize,
      mimeType: input.mimeType,
      checksum: input.checksum,
      durationSeconds: input.durationSeconds,
      capturedAt: input.capturedAt,
      sourceMetadataStripped: input.sourceMetadataStripped,
      sourceCarriesNoLocation: input.sourceCarriesNoLocation,
      ...challenge,
      now,
    });

    await recordGrantIssued(ctx, throttleKey, now);

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.uploadGranted,
      subjectType: "media",
      subjectId: issued.grantId,
      actor: { userId: actor.user._id, role: actor.role },
      eventId: actor.event._id,
      // No secret, no checksum, no filename. Enough to reconstruct who was
      // allowed to send what kind of thing, and nothing that identifies the
      // photo itself.
      metadata: {
        captureId: input.captureId,
        mediaType: input.mediaType,
        fileRole: input.fileRole,
        mediaSource: input.mediaSource,
        byteSize: input.byteSize,
        storageRegion: actor.event.storageRegion,
      },
      now,
    });

    return {
      outcome: "granted",
      grantId: issued.grantId,
      secret: issued.secret,
      eventId: actor.event._id,
      captureId: input.captureId,
      mediaType: input.mediaType,
      fileRole: input.fileRole,
      mediaSource: input.mediaSource,
      storageRegion: actor.event.storageRegion,
      byteSize: input.byteSize,
      maxBytes: grantSizeCap(input.mediaType, input.fileRole),
      expiresAt: issued.expiresAt,
    };
  },
});

async function trustedChallengeForGrant(
  ctx: MutationCtx,
  params: {
    assignmentId?: string;
    eventId: Id<"events">;
    userId: Id<"users">;
    captureId: string;
  },
): Promise<{ challengeId?: Id<"photoChallenges">; challengePrompt?: string }> {
  if (params.assignmentId === undefined) return {};
  const assignment = await ctx.db.get(params.assignmentId as Id<"photoChallengeAssignments">);
  if (
    !assignment ||
    assignment.eventId !== params.eventId ||
    assignment.userId !== params.userId ||
    assignment.status !== "used" ||
    assignment.usedCaptureId !== params.captureId
  ) {
    throw forbidden("That photo challenge is not available for this capture.");
  }
  return { challengeId: assignment.challengeId, challengePrompt: assignment.promptSnapshot };
}

/**
 * May this account be granted an **original** for this capture?
 *
 * A capture is uploaded once. A *retry* re-uses the `captureId` and is the whole
 * point of it; a second file under the same id is not a retry.
 *
 * `captureId` is generated by the client and the index is scoped to the event,
 * not to the person — so two guests at one party *can* propose the same id, by
 * accident or on purpose. Whoever got there first keeps it. Without that the
 * resume path below is a hijack: guest B asks for a grant naming guest A's
 * stranded `processing` capture and `ensureMediaRow` hands B's completion A's
 * row — B's photo, filed under A's name, in A's "my media" list, withdrawable
 * only by A.
 */
function checkOriginalGrant(
  userId: Id<"users">,
  existing: Doc<"media"> | null,
  requested: CaptureFileFacts,
): UploadRejectionReason | undefined {
  if (existing === null) return undefined;

  const isOwn = existing.uploaderUserId === userId;

  // The one exception, and only for the person it belongs to: a grant that
  // expired mid-upload leaves a `processing` row with no file, and refusing the
  // retry would strand the guest's photo on their phone for ever.
  const isResumable = isOwn && existing.state === "processing" && existing.storageKey === undefined;
  if (isResumable) {
    /*
     * …and only for the **same file**.
     *
     * The row was created from the first grant and every fact on it — media
     * type, MIME type, byte size, checksum, duration — is the record from that
     * moment on. `ensureMediaRow` returns this row unchanged for the retry, so a
     * second grant describing something else does not correct the record; it
     * attaches bytes to a record of something else. A 200 MB clip lands on a row
     * that says `photo` / `image/jpeg` / 900 kB, `storedBytesOf` under-reports
     * the party by two orders of magnitude, and every renderer downstream
     * believes the row.
     *
     * Both first-party clients retry from the draft they already encoded, so the
     * facts are stable across a retry by construction. A client that genuinely
     * produced different bytes has produced a different capture and needs a
     * `captureId` to match.
     */
    return describesSameFile(existing, requested) ? undefined : "captureFactsChanged";
  }

  return isOwn && existing.state === "deleted" ? "captureWithdrawn" : "duplicateCapture";
}

/**
 * Prove that a retry is the client's own original which already completed.
 *
 * `duplicateCapture` deliberately carries no media id: a capture id is scoped
 * to an event, so the collision may belong to another guest. Reconciliation is
 * consequently stricter than duplicate detection. It requires the same owner,
 * every fact the grant binds, an attached storage object, and a state reached
 * only after processing settled. Derivatives do not call this helper and keep
 * their existing duplicate policy.
 */
function reconcileAlreadyUploaded(
  userId: Id<"users">,
  existing: Doc<"media"> | null,
  requested: CaptureFileFacts,
):
  | {
      outcome: "alreadyUploaded";
      mediaId: Id<"media">;
      state: "pending" | "approved" | "declined";
    }
  | undefined {
  if (existing === null || existing.uploaderUserId !== userId) return undefined;
  if (existing.storageKey === undefined || !describesSameFile(existing, requested)) {
    return undefined;
  }
  if (
    existing.state !== "pending" &&
    existing.state !== "approved" &&
    existing.state !== "declined"
  ) {
    return undefined;
  }
  return { outcome: "alreadyUploaded", mediaId: existing._id, state: existing.state };
}

/**
 * May this account be granted a **derivative** for this capture?
 *
 * Three things have to be true, and each of them is a door that would otherwise
 * be open:
 *
 * 1. **The capture is theirs.** A derivative grant names an existing capture by
 *    id, so without an ownership check any member could attach a "preview" to
 *    anybody's photo — and the preview is the artefact the whole gallery is
 *    served. This is the most dangerous of the three and the reason a derivative
 *    grant is not simply an original grant with a different column.
 * 2. **The original was asked for.** Not that it has *landed* — clients fire the
 *    original and the preview off together, and demanding the completion first
 *    would serialise every upload behind a US-East round trip. A grant for the
 *    original having been issued to this account is enough, and it is checked
 *    against the grants table rather than the media row for exactly that reason.
 * 3. **That role is still empty.** One capture has one preview and one poster.
 *
 * A withdrawn capture is refused outright: `media.withdraw` expires every
 * unspent grant precisely so nothing can attach afterwards, and a derivative is
 * something attaching afterwards.
 */
async function checkDerivativeGrant(
  ctx: MutationCtx,
  params: {
    userId: Id<"users">;
    eventId: Id<"events">;
    captureId: string;
    role: DerivativeFileRole;
    /** What the request says this capture is. Corroborated, never believed. */
    mediaType: Doc<"media">["mediaType"];
    /** The derivative's own checksum, which must differ from the original's. */
    checksum: string;
    existing: Doc<"media"> | null;
  },
): Promise<UploadRejectionReason | undefined> {
  const { existing } = params;

  if (existing !== null) {
    if (existing.uploaderUserId !== params.userId) return "duplicateCapture";
    if (existing.state === "deleted") return "captureWithdrawn";
    const filled = params.role === "preview" ? existing.previewKey : existing.posterKey;
    if (filled !== undefined) return "duplicateDerivative";
    // The row is the authority on what this capture *is*: a client asking for a
    // poster against a capture that landed as a photo has drifted, whatever its
    // own request said the media type was.
    if (existing.mediaType !== params.mediaType) return "captureFactsChanged";
    if (!isFileRoleAllowed(existing.mediaType, params.role)) return "unsupportedFileRole";
    return checkDerivativeIsDistinct(params.checksum, existing, params.role);
  }

  // No media row yet, so the original's own completion has not arrived. Accept
  // only if this account has already been issued a grant for the original —
  // otherwise a member could mint previews for captures that will never exist.
  const grants = await ctx.db
    .query("uploadGrants")
    .withIndex("by_event_and_capture", (q) =>
      q.eq("eventId", params.eventId).eq("captureId", params.captureId),
    )
    .collect();

  const ownOriginal = grants.find(
    (grant) => grant.userId === params.userId && fileRoleOf(grant) === "original",
  );
  if (ownOriginal === undefined) return "derivativeWithoutOriginal";

  const foreign = grants.some((grant) => grant.userId !== params.userId);
  if (foreign) return "duplicateCapture";

  if (ownOriginal.mediaType !== params.mediaType) return "captureFactsChanged";
  if (!isFileRoleAllowed(ownOriginal.mediaType, params.role)) return "unsupportedFileRole";
  if (ownOriginal.checksum === params.checksum) return "derivativeNotDistinct";

  // A sibling derivative already granted under this capture with the same body
  // is the same re-upload by another name.
  const sibling = grants.some(
    (grant) => isDerivativeRole(fileRoleOf(grant)) && grant.checksum === params.checksum,
  );
  return sibling ? "derivativeNotDistinct" : undefined;
}

/**
 * A derivative must not be its own source.
 *
 * The re-encode claim (`derivativeMetadataNotStripped`) is a client's word, and
 * the 2 MiB cap is corroboration rather than proof — the ADR 0008 comment
 * concedes that "a small image can still carry GPS". This is the check that
 * turns the claim into something a server can falsify without an image pipeline:
 * a decode/re-encode round trip never reproduces its input byte for byte, so a
 * derivative whose checksum equals the original's is the original, re-labelled.
 *
 * That matters because `projectMedia` hands `previewUrl` and `posterUrl` to
 * **every** viewer. Without this, a guest whose original was deliberately
 * withheld from third parties could re-upload the identical GPS-bearing file
 * under `fileRole: "preview"` and be served it back to the whole gallery — the
 * "serve nothing" branch bypassed by exactly the actor it defends against.
 */
function checkDerivativeIsDistinct(
  checksum: string,
  media: Doc<"media">,
  role: DerivativeFileRole,
): UploadRejectionReason | undefined {
  if (media.checksum === checksum) return "derivativeNotDistinct";
  // The **other** role only. A second grant carrying the same body for the *same*
  // role is a client retrying a slow upload, which is ordinary and is settled by
  // `attachDerivative` as a duplicate rather than treated as a swap attempt.
  const sibling = role === "preview" ? media.posterChecksum : media.previewChecksum;
  return sibling === checksum ? "derivativeNotDistinct" : undefined;
}

/**
 * Refuse a grant, and leave a row saying why.
 *
 * Audited — unlike the throttled path — because these are the refusals that
 * explain a guest standing at a party unable to send anything: the host paused
 * the event, or turned library imports off, or their phone is producing 30 MB
 * HEICs. "Nobody could upload for twenty minutes" has to be answerable
 * afterwards, and the media row that would normally carry the story is exactly
 * what does not exist here.
 */
async function rejectGrant(
  ctx: MutationCtx,
  params: {
    actor: EventActor;
    captureId: string;
    reason: UploadRejectionReason;
    now: number;
  },
): Promise<GrantResult<Id<"uploadGrants">, Id<"events">, Id<"media">>> {
  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.uploadRejected,
    subjectType: "media",
    actor: { userId: params.actor.user._id, role: params.actor.role },
    eventId: params.actor.event._id,
    metadata: { captureId: params.captureId, reason: params.reason },
    now: params.now,
  });
  return grantRejected(params.reason);
}

/* -------------------------------------------------------------------------- */
/* 2. Authenticated preflight and client reconciliation                       */
/* -------------------------------------------------------------------------- */

/**
 * The authenticated half of the two-sided completion.
 *
 * Its first call is UploadThing middleware preflight: it atomically reserves an
 * unexpired grant before the provider issues a URL. It may create the media row,
 * but does not consume the grant, set a storage key or move the state. Its later
 * call is the phone reconciling after transport; that call gets row state but no
 * authorising facts, so replaying the secret through middleware cannot create a
 * second URL.
 *
 * Its value is latency: the "uploading…" spinner on a phone can turn into
 * "waiting for the host" the moment the bytes leave, without waiting for a
 * server-to-server callback to cross the country.
 *
 * ## Why it also returns `mediaType`, `byteSize` and `mimeType`
 *
 * Because the UploadThing middleware in `apps/web` calls this, and until it did
 * there was **nothing in the request path that knew what the grant authorised**.
 * The middleware only ever saw the ticket, and a ticket is entirely
 * client-written: a guest holding a legitimate 1 MB photo grant could declare
 * `mediaType: "video", byteSize: 250 MB`, pass every edge check, and have a
 * quarter of a gigabyte written to private storage before Convex rejected it on
 * the way back out. Answering with the grant's own facts is what lets the edge
 * refuse that before any bytes move.
 *
 * It discloses nothing: the caller has already proven it holds this grant, and
 * these are the three values it sent when it asked for one.
 */
export const confirmUpload = mutation({
  args: { secret: v.string() },
  returns: v.object({
    mediaId: v.union(v.id("media"), v.null()),
    state: v.union(mediaState, v.null()),
    /** Authorising facts are present only on the call which reserved the grant. */
    mediaType: v.union(mediaType, v.null()),
    fileRole: v.union(mediaFileRole, v.null()),
    byteSize: v.union(v.number(), v.null()),
    mimeType: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(confirmUploadInputSchema, args);
    const now = Date.now();
    const reservation = await startGrant(ctx, input.secret, user._id, now);
    // An unknown or foreign secret is `notFound`, not `forbidden`: the two
    // answers must not tell a caller whether a secret exists.
    if (!reservation.ok && reservation.reason === "unknownGrant") throw notFound("That upload");
    const grant = reservation.grant;

    // Only the transaction which changed `issued → started` gets authorising
    // file facts. A second authenticated call may still reconcile the media id
    // for the phone after transport completion, but returning nulls makes the
    // UploadThing middleware refuse a replay before it can mint another URL.
    const authorised = reservation.ok
      ? {
          mediaType: grant.mediaType,
          fileRole: fileRoleOf(grant),
          byteSize: grant.byteSize,
          mimeType: grant.mimeType,
        }
      : { mediaType: null, fileRole: null, byteSize: null, mimeType: null };

    const existing = await findMediaByCapture(ctx, grant.eventId, grant.captureId);
    if (existing) {
      // Never regress a row the callback has already settled, and never revive a
      // withdrawn one.
      return { mediaId: existing._id, state: existing.state, ...authorised };
    }

    // A derivative never creates the row. It describes a file *about* a capture,
    // and everything on a media row — byte size, checksum, mime type — has to
    // come from the original's grant or the row would describe the thumbnail.
    // Arriving here means the original's own confirmation is still in flight,
    // which is normal and is not an error.
    if (isDerivativeRole(fileRoleOf(grant))) {
      return { mediaId: null, state: null, ...authorised };
    }

    // Only a fresh preflight creates anything. Expired grants and replays can
    // reconcile an existing row above, but cannot reserve storage again.
    if (!reservation.ok) {
      return { mediaId: null, state: null, ...authorised };
    }

    const row = await ensureMediaRow(ctx, grant, now);
    // Somebody else already owns this captureId in this event. Nothing to
    // confirm, and nothing to say about a row that is not theirs.
    if (row === null) throw notFound("That upload");

    await linkGrantToMedia(ctx, grant._id, row.media._id, now);
    return { mediaId: row.media._id, state: row.media.state, ...authorised };
  },
});

/* -------------------------------------------------------------------------- */
/* 3. The provider says what landed                                           */
/* -------------------------------------------------------------------------- */

const completionValidator = v.object({
  outcome: v.union(
    v.literal("registered"),
    v.literal("duplicate"),
    v.literal("discarded"),
    v.literal("rejected"),
  ),
  mediaId: v.optional(v.id("media")),
  state: v.optional(mediaState),
  reason: v.optional(v.string()),
});

interface CompletionResult {
  outcome: UploadCompletionOutcome;
  mediaId?: Id<"media">;
  state?: MediaState;
  reason?: string;
}

/**
 * Register a stored file against its grant.
 *
 * **Server-only.** Two credentials are required and they answer different
 * questions: the *grant secret* says which upload this is, and
 * `UPLOAD_CALLBACK_SECRET` says that the caller is our own UploadThing route
 * handler. Without the second, a guest holding the grant they were legitimately
 * given could name any file key in the app — including one belonging to another
 * party — and have a media row point at it.
 *
 * Every outcome except `rejected` is a **success** to the caller. A completion
 * callback that returns an error is one the provider retries, and the failure
 * modes here (a duplicate, a file for a withdrawn capture) are precisely the
 * ones where retrying forever is the wrong answer.
 */
export const completeUpload = mutation({
  args: {
    callbackSecret: v.string(),
    secret: v.string(),
    fileKey: v.string(),
    byteSize: v.number(),
    mimeType: v.optional(v.string()),
    checksum: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    durationSeconds: v.optional(v.number()),
  },
  returns: completionValidator,
  handler: async (ctx, args): Promise<CompletionResult> => {
    requireUploadCallbackSecret(args.callbackSecret);
    const input = parseInput(completeUploadInputSchema, args);
    const now = Date.now();

    const consumption = await consumeGrant(ctx, input.secret, input.fileKey, now);

    if (!consumption.ok) {
      if (consumption.reason === "unknownGrant") {
        // Nothing to attach the file to and no event to charge it against. The
        // object is orphaned; the purge sweep (P1) is what collects it, because
        // deleting on the strength of an unauthenticated key is a delete
        // primitive we are not going to build.
        return { outcome: "rejected", reason: "unknownGrant" };
      }
      if (consumption.reason === "alreadyConsumed") {
        return await reconcileDuplicate(ctx, consumption.grant, input.fileKey, now);
      }
      // Expired or a callback which somehow bypassed authenticated preflight.
      // The bytes are real and nobody may ever see them.
      return await discard(ctx, {
        grant: consumption.grant,
        fileKey: input.fileKey,
        reason: consumption.reason,
        now,
      });
    }

    const grant = consumption.grant;

    /*
     * The freeze, re-asked at the one place bytes are accepted.
     *
     * Every other check in the upload path asks about the *caller* or about the
     * grant, and a grant is a capability issued when the answer was still yes.
     * `admin.lockAccount` expires outstanding grants, but a freeze whose only
     * enforcement is an enumeration performed at lock time is a freeze that the
     * next code path to mint a grant quietly escapes — and TODO.md's RC5 is
     * literally "lock the organiser and watch everything freeze".
     *
     * So it is asked here as well, where it cannot be missed: the grant is
     * already spent (it must not survive a refusal) and the bytes go. The same
     * line covers a deletion-scheduled or deleted owner, because `eventFreeze`
     * is derived from the owner's account state rather than from the lock.
     */
    const event = await ctx.db.get(grant.eventId);
    if (!event) {
      return await discard(ctx, { grant, fileKey: input.fileKey, reason: "eventGone", now });
    }
    const freeze = await eventFreeze(ctx, event);
    if (freeze.frozen) {
      return await discard(ctx, { grant, fileKey: input.fileKey, reason: freeze.reason, now });
    }

    const match = matchesGrant(grant, {
      fileKey: input.fileKey,
      byteSize: input.byteSize,
      checksum: input.checksum,
    });
    if (!match.ok) {
      // Something other than what was promised is now in private storage. The
      // grant is already spent — it must not be re-usable after a swap attempt —
      // and the object goes.
      return await discard(ctx, {
        grant,
        fileKey: input.fileKey,
        reason: match.reason,
        now,
      });
    }

    /*
     * The 60-second cap, enforced a second time on the way in.
     *
     * `checkGrantEligibility` already refused an over-long video at grant time,
     * but the duration it judged was the client's own estimate before the file
     * existed. This is the number reported for the object that actually landed,
     * and the two can disagree — a recorder that overshoots the stop, a client
     * that rounds down. `byteSize` is bound by `matchesGrant` and cannot move;
     * duration is not, so without this the 250 MB cap is the only real ceiling
     * on a video and PLAN.md's "≤ 60 s" is a suggestion.
     */
    if (grant.mediaType === "video" && overVideoDuration(input.durationSeconds)) {
      return await discard(ctx, { grant, fileKey: input.fileKey, reason: "tooLong", now });
    }

    if (isDerivativeRole(fileRoleOf(grant))) {
      return await registerDerivative(ctx, {
        grant,
        role: fileRoleOf(grant) as DerivativeFileRole,
        fileKey: input.fileKey,
        byteSize: input.byteSize,
        now,
      });
    }

    const row = await ensureMediaRow(ctx, grant, now);
    if (row === null) {
      // The capture belongs to another guest. The bytes are real and can never
      // be attached to anything, so they go.
      return await discard(ctx, {
        grant,
        fileKey: input.fileKey,
        reason: "captureOwnedByOther",
        now,
      });
    }
    const media = row.media;

    /*
     * The grant against the row it is about to fill, a second time.
     *
     * `checkOriginalGrant` refused a retry that described a different file, but
     * that ran when the grant was minted and this runs when the bytes have
     * landed — and the row can have been created by a *different* grant in
     * between (two grants in flight for one capture is exactly what a flaky
     * retry produces). `ensureMediaRow` returns the existing row untouched, so
     * without this the second grant's bytes attach to the first grant's record.
     */
    if (!row.created && media.storageKey === undefined && !grantDescribesRow(grant, media)) {
      return await discard(ctx, {
        grant,
        fileKey: input.fileKey,
        reason: "captureFactsChanged",
        now,
      });
    }

    if (media.state === "deleted") {
      // The submitter withdrew while the bytes were still in flight. Withdrawal
      // is permanent, so the late arrival is deleted rather than attached.
      return await discard(ctx, { grant, fileKey: input.fileKey, reason: "withdrawn", now });
    }

    if (media.storageKey !== undefined) {
      // A second, different file against a capture that already has one.
      if (media.storageKey !== input.fileKey) {
        return await discard(ctx, { grant, fileKey: input.fileKey, reason: "duplicateFile", now });
      }
      return { outcome: "duplicate", mediaId: media._id, state: media.state };
    }

    /*
     * The provider-reported content type is a **claim**, and it reaches us
     * having passed through the client that uploaded the body. Patching it onto
     * the row unchecked let an item settle carrying a `mimeType` its grant's
     * `mediaType` does not admit — a row saying `video/mp4` under a photo grant,
     * which every downstream renderer then believes.
     *
     * A disagreement is not a correction, so the grant's own (already validated)
     * mimeType is kept and the provider's is dropped. It is not grounds to
     * discard the bytes: `matchesGrant` has already agreed on byte size and
     * checksum, so this is a provider or client that describes the same body
     * differently, not a different body.
     */
    const reportedMime =
      input.mimeType !== undefined &&
      normaliseMime(input.mimeType) === normaliseMime(grant.mimeType)
        ? normaliseMime(grant.mimeType)
        : undefined;

    await ctx.db.patch(media._id, {
      storageKey: input.fileKey,
      grantId: grant._id,
      uploadedAt: now,
      updatedAt: now,
      ...(reportedMime === undefined ? {} : { mimeType: reportedMime }),
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    });
    await linkGrantToMedia(ctx, grant._id, media._id, now);

    // `event` was loaded and freeze-checked above, before the grant was allowed
    // to produce anything at all.
    const settled = await ctx.db.get(media._id);
    const state = await settleAfterProcessing(ctx, settled ?? media, event, now);

    /*
     * The duration check that is finally independent of the client.
     *
     * The two that existed both read a number the *client* supplied — the grant
     * carried the client's estimate and the completion callback forwards
     * `metadata.durationSeconds`, which is copied verbatim off the upload
     * ticket. So a modified client could declare eight seconds and upload a
     * ten-minute recording; as long as it fitted under the 250 MB ceiling
     * nothing anywhere disagreed, and "≤ 60 s" was a suggestion with two
     * enforcement points pointing at the same claim.
     *
     * A mutation has no network, so this is scheduled: `verifyVideoDuration`
     * fetches the object's own first bytes and reads the duration out of the
     * container. It runs *after* the row settles rather than before, because
     * making every guest wait on a round trip to storage before their photo
     * appears is the wrong trade at a party — the window in which an over-long
     * clip is visible is seconds, and what closes it is a real measurement
     * rather than an earlier reading of the same lie.
     */
    if (grant.mediaType === "video") {
      await ctx.scheduler.runAfter(0, mediaFunctions.verifyVideoDuration, { mediaId: media._id });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.uploadCompleted,
      subjectType: "media",
      subjectId: media._id,
      actor: { userId: grant.userId },
      eventId: grant.eventId,
      metadata: {
        captureId: grant.captureId,
        mediaType: grant.mediaType,
        byteSize: grant.byteSize,
        state,
        storageRegion: grant.storageRegion,
        moderationMode: event.moderationMode,
      },
      now,
    });

    return { outcome: "registered", mediaId: media._id, state };
  },
});

/** Does this grant describe the same file the row already records? */
function grantDescribesRow(grant: Doc<"uploadGrants">, media: Doc<"media">): boolean {
  return describesSameFile(grant, media);
}

/** Is a reported video duration outside the launch cap? */
function overVideoDuration(durationSeconds: number | undefined): boolean {
  if (durationSeconds === undefined) return false;
  return !Number.isFinite(durationSeconds) || durationSeconds > VIDEO_MAX_DURATION_SECONDS;
}

/**
 * Attach a landed derivative to the capture it belongs to.
 *
 * The mirror of the original's half of {@link completeUpload}, and deliberately
 * much smaller: it writes one column and nothing else. It does **not** settle
 * the row, move a counter, or write an `uploadCompleted` audit row, because a
 * capture that arrives as three objects is still one submission — folding
 * derivatives into that action would treble every party's apparent size and
 * would make the pending badge count thumbnails.
 *
 * Ordering does not matter. A preview that lands before its original finds no
 * media row, and the bytes are discarded rather than orphaned: the row will be
 * created from the original's grant a moment later, and the client's retry
 * (which re-requests a grant, which re-runs every check) is what reattaches it.
 * That is the conservative branch on purpose — the alternative is inventing a
 * media row out of a thumbnail's byte size and checksum.
 */
async function registerDerivative(
  ctx: MutationCtx,
  params: {
    grant: Doc<"uploadGrants">;
    role: DerivativeFileRole;
    fileKey: string;
    byteSize: number;
    now: number;
  },
): Promise<CompletionResult> {
  const { grant, now } = params;
  const media = await findMediaByCapture(ctx, grant.eventId, grant.captureId);

  if (media === null) {
    return await discard(ctx, {
      grant,
      fileKey: params.fileKey,
      reason: "derivativeWithoutOriginal",
      now,
    });
  }
  if (media.uploaderUserId !== grant.userId) {
    return await discard(ctx, {
      grant,
      fileKey: params.fileKey,
      reason: "captureOwnedByOther",
      now,
    });
  }
  if (media.state === "deleted") {
    // Withdrawal is permanent, and it expires unspent grants precisely so this
    // cannot happen — but the callback for one already in flight can still land.
    return await discard(ctx, { grant, fileKey: params.fileKey, reason: "withdrawn", now });
  }

  /*
   * The row is the authority on what this capture is, and it is re-read here
   * rather than trusted from grant time.
   *
   * A grant issued before the original's completion landed was checked against
   * *another grant*; by now there is a row, and the row may say something else.
   * A `poster` grant minted under `mediaType: "video"` against a capture that
   * landed as a photo would otherwise attach video-shaped bytes to a photo's
   * `posterKey`, which is precisely the "type and role do not match the
   * authoritative row" case.
   */
  if (grant.mediaType !== media.mediaType || !isFileRoleAllowed(media.mediaType, params.role)) {
    return await discard(ctx, {
      grant,
      fileKey: params.fileKey,
      reason: "captureFactsChanged",
      now,
    });
  }

  // A derivative that is byte-for-byte the original is the original. See
  // `checkDerivativeIsDistinct` — this is the same rule applied against the row
  // that exists now rather than the grants that existed then.
  if (checkDerivativeIsDistinct(grant.checksum, media, params.role) !== undefined) {
    return await discard(ctx, {
      grant,
      fileKey: params.fileKey,
      reason: "derivativeNotDistinct",
      now,
    });
  }

  const attachment = await attachDerivative(ctx, media, {
    role: params.role,
    fileKey: params.fileKey,
    byteSize: params.byteSize,
    checksum: grant.checksum,
    carriesNoLocation: metadataClaimOf(grant).carriesNoLocation,
    now,
  });

  if (attachment === "conflict") {
    return await discard(ctx, {
      grant,
      fileKey: params.fileKey,
      reason: "duplicateDerivative",
      now,
    });
  }

  await linkGrantToMedia(ctx, grant._id, media._id, now);

  if (attachment === "duplicate") {
    return { outcome: "duplicate", mediaId: media._id, state: media.state };
  }

  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.derivativeAttached,
    subjectType: "media",
    subjectId: media._id,
    actor: { userId: grant.userId },
    eventId: grant.eventId,
    metadata: {
      captureId: grant.captureId,
      fileRole: params.role,
      mediaType: grant.mediaType,
      byteSize: params.byteSize,
      storageRegion: grant.storageRegion,
    },
    now,
  });

  return { outcome: "registered", mediaId: media._id, state: media.state };
}

/**
 * The provider called back twice for one grant.
 *
 * The common case by far, and it must change nothing. `consumedFileKey` is what
 * makes "the same callback again" distinguishable from "a second file against
 * one grant": the first is a no-op, the second is an object nobody asked for.
 */
async function reconcileDuplicate(
  ctx: MutationCtx,
  grant: Doc<"uploadGrants">,
  fileKey: string,
  now: number,
): Promise<CompletionResult> {
  if (grant.consumedFileKey !== undefined && grant.consumedFileKey !== fileKey) {
    return await discard(ctx, { grant, fileKey, reason: "duplicateFile", now });
  }

  const media =
    grant.mediaId !== undefined
      ? await ctx.db.get(grant.mediaId)
      : await findMediaByCapture(ctx, grant.eventId, grant.captureId);

  if (!media) return { outcome: "duplicate" };
  return { outcome: "duplicate", mediaId: media._id, state: media.state };
}

/**
 * Bytes that exist and must not: delete them, and say why in the audit log.
 *
 * A Convex mutation has no network, so the delete is scheduled rather than done
 * — `purgeStoredFile` is an action, which may. The audit row is written here, in
 * the transaction that decided, so the decision survives even if the delete has
 * to be retried.
 */
async function discard(
  ctx: MutationCtx,
  params: { grant: Doc<"uploadGrants">; fileKey: string; reason: string; now: number },
): Promise<CompletionResult> {
  const purgeJobId = await createStoragePurgeJob(ctx, {
    region: params.grant.storageRegion,
    keys: [params.fileKey],
    source: "rejectedUpload",
    now: params.now,
  });
  await ctx.scheduler.runAfter(0, mediaFunctions.purgeStoredFile, {
    region: params.grant.storageRegion,
    keys: [params.fileKey],
    purgeJobId,
  });

  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.uploadDiscarded,
    subjectType: "media",
    subjectId: params.grant._id,
    actor: { userId: params.grant.userId },
    eventId: params.grant.eventId,
    metadata: { captureId: params.grant.captureId, reason: params.reason },
    now: params.now,
  });

  return { outcome: "discarded", reason: params.reason };
}

/* -------------------------------------------------------------------------- */
/* 4. Withdrawal                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The submitter takes it back, in any state, for ever.
 *
 * "For ever" is three separate facts, and all three are enforced here rather
 * than implied:
 *
 * - `deleted` is **terminal** in the media state machine, so nothing can move
 *   the row back.
 * - Any unspent grant for the capture is expired, so an upload still in flight
 *   cannot complete against it.
 * - A late callback that arrives anyway finds the row `deleted` and deletes its
 *   own file (see {@link completeUpload}).
 *
 * Only the submitter may do it — `media.withdrawOwn` is gated on `isOwn`, and a
 * host wanting the item gone uses `media.delete`, which is a different action
 * with a different audit row. That distinction matters for the same reason
 * "who un-declined this at 1am" does.
 */
export const withdraw = mutation({
  args: { mediaId: v.id("media"), reason: v.optional(v.string()) },
  returns: v.object({ state: mediaState }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(withdrawMediaInputSchema, args);

    const media = await ctx.db.get(args.mediaId);
    if (!media) throw notFound("That photo");

    // Same refusal for "no such photo" and "a photo in a party you are not in":
    // media ids are stable and handed out, so two messages would confirm that an
    // id belongs to somebody else's party. See `requireEventActorFor`.
    const actor = await requireEventActorFor(ctx, media.eventId, "That photo");

    requirePermission(toPermissionActor(actor.user, actor.role), "media.withdrawOwn", {
      kind: "media",
      state: media.state,
      isOwn: media.uploaderUserId === user._id,
      event: { state: actor.event.state },
    });

    const now = Date.now();
    mediaStateMachine.assertTransition(media.state, "deleted");

    await ctx.db.patch(media._id, {
      state: "deleted",
      withdrawnAt: now,
      deletedAt: now,
      updatedAt: now,
    });
    await applyCountChange(ctx, media.eventId, media.state, "deleted", now);
    await expireGrantsForCapture(ctx, media.eventId, media.captureId, now);

    // Every object the capture names, derivatives included — a withdrawn photo
    // whose preview survived is a withdrawn photo the gallery can still render.
    const keys = storageKeysOf(media);
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, mediaFunctions.purgeStoredFile, {
        region: media.storageRegion,
        keys,
        mediaId: media._id,
      });
    } else {
      // Nothing was ever stored, so the storage side is already settled.
      await ctx.db.patch(media._id, { storageDeletedAt: now });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.mediaWithdrawn,
      subjectType: "media",
      subjectId: media._id,
      actor: { userId: user._id, role: actor.role },
      eventId: media.eventId,
      reason: input.reason,
      metadata: {
        captureId: media.captureId,
        previousState: media.state,
        fileCount: keys.length,
      },
      now,
    });

    return { state: "deleted" as const };
  },
});

/* -------------------------------------------------------------------------- */
/* Storage side-effects (actions — the only place with a network)             */
/* -------------------------------------------------------------------------- */

/**
 * How long to wait before each re-attempt at deleting objects.
 *
 * Bounded and explicit because **Convex does not retry a failed scheduled
 * action**. Only mutations get automatic retry; an action that throws is logged
 * and forgotten, which for this function means a withdrawn guest's photo sitting
 * in private storage indefinitely behind a row that says it is gone. The retry
 * therefore has to be written, and its length is the array: four attempts over
 * about six minutes, which covers a provider blip without turning a permanent
 * misconfiguration (no `UPLOADTHING_TOKEN`) into an endless scheduler loop.
 */
const PURGE_RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;

export const purgeStoredFile = internalAction({
  args: {
    region: storageRegion,
    keys: v.array(v.string()),
    mediaId: v.optional(v.id("media")),
    /** Durable pointer when there is no retained media row. */
    purgeJobId: v.optional(v.id("storagePurgeJobs")),
    /** 1 for the first try. Threaded so the backoff is stateless. */
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    const adapter = resolveStorageAdapter(args.region);

    let deleted: number;
    try {
      const result = await adapter.deleteFiles(args.keys);
      if (!result.success) {
        throw new Error("Storage provider did not confirm deletion.");
      }
      deleted = result.deleted;
    } catch (error) {
      /*
       * A failed delete used to be invisible: the action threw, the comment here
       * claimed Convex would retry it, and nothing did. So this reports, then
       * re-schedules itself with a bounded backoff, and gives up loudly rather
       * than quietly. `reportError` is safe in an action — actions have `fetch`
       * — and falls back to a scrubbed `console.error` with no DSN.
       */
      const nextDelay = PURGE_RETRY_DELAYS_MS[attempt - 1];
      await reportError({
        scope: "media.purgeStoredFile",
        error,
        level: nextDelay === undefined ? "error" : "warning",
        extra: {
          region: args.region,
          keyCount: args.keys.length,
          attempt,
          willRetry: nextDelay !== undefined,
          ...(args.mediaId === undefined ? {} : { mediaId: args.mediaId }),
          ...(args.purgeJobId === undefined ? {} : { purgeJobId: args.purgeJobId }),
        },
      });

      if (args.purgeJobId !== undefined) {
        await ctx.runMutation(mediaFunctions.markGenericStoragePurgeAttempt, {
          purgeJobId: args.purgeJobId,
          attempts: attempt,
          reason: "deleteFailed",
        });
      }

      if (nextDelay !== undefined) {
        await ctx.scheduler.runAfter(nextDelay, mediaFunctions.purgeStoredFile, {
          region: args.region,
          keys: args.keys,
          ...(args.mediaId === undefined ? {} : { mediaId: args.mediaId }),
          ...(args.purgeJobId === undefined ? {} : { purgeJobId: args.purgeJobId }),
          attempt: attempt + 1,
        });
        return null;
      }

      if (args.mediaId !== undefined) {
        await ctx.runMutation(mediaFunctions.markStoragePurgeFailed, {
          mediaId: args.mediaId,
          attempts: attempt,
          requested: args.keys.length,
          deleted: 0,
        });
      }
      if (args.purgeJobId !== undefined) {
        await ctx.runMutation(mediaFunctions.markGenericStoragePurgeFailed, {
          purgeJobId: args.purgeJobId,
          attempts: attempt,
          requested: args.keys.length,
          deleted: 0,
          reason: "deleteFailed",
        });
      }
      return null;
    }

    if (args.mediaId !== undefined) {
      await ctx.runMutation(mediaFunctions.markStoragePurged, {
        mediaId: args.mediaId,
        deleted,
        requested: args.keys.length,
      });
    }
    if (args.purgeJobId !== undefined) {
      await ctx.runMutation(mediaFunctions.markGenericStoragePurged, {
        purgeJobId: args.purgeJobId,
        attempts: attempt,
        requested: args.keys.length,
        deleted,
      });
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/* The video duration probe                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much of a video to read before giving up on finding its `moov`.
 *
 * A recording written for streaming puts `moov` first, and every clip either
 * client produces is one. A recording that puts it last is read from the tail
 * instead, which is the second range request below. 512 KiB comfortably covers
 * both headers without pulling a meaningful fraction of a 250 MB file.
 */
const DURATION_PROBE_BYTES = 512 * 1024;

/**
 * Measure a stored video and refuse it if it is over the cap.
 *
 * This is the only duration check in the product with a **server-observed**
 * number on one side. `checkGrantEligibility` judged the client's estimate
 * before the file existed, and `completeUpload` judged the completion
 * callback's — which the route handler copies straight off the client-authored
 * upload ticket, so the "landed object" check was reading the same claim a
 * second time. A modified client declaring eight seconds could store a
 * ten-minute recording and nothing disagreed.
 *
 * The measurement is arithmetic on twenty bytes of the file's own header
 * (`@partybooth/contracts/video`), which is the most a Convex isolate can do —
 * it has no native modules and therefore no decoder — and it is enough, because
 * the container states its own duration.
 *
 * **Three verdicts, three different actions**, and the third is the one worth
 * being careful about:
 *
 * - `overCap` — the object is deleted and the row is tombstoned. The bytes are
 *   real, they exceed a limit the product states, and no retry changes that.
 * - `withinCap` — the measured duration replaces the claimed one on the row, so
 *   the figure a host sees is the file's rather than the phone's.
 * - `unverifiable` — an unrecognised container (WebM, from a browser's library
 *   import) or a header we could not reach. The file is **kept**, the row records
 *   that the check did not run, and an audit line says so. Deleting a guest's
 *   fifty-five-second clip because a parser did not recognise its container is a
 *   worse failure at a party than the one this exists to prevent.
 */
export const verifyVideoDuration = internalAction({
  args: { mediaId: v.id("media") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const media = await ctx.runQuery(mediaFunctions.mediaForDurationProbe, {
      mediaId: args.mediaId,
    });
    if (media === null || media.storageKey === undefined) return null;

    let measured: number | undefined;
    try {
      measured = await measureStoredDuration(media.storageRegion, media.storageKey);
    } catch (error) {
      // Storage was unreachable. That is not evidence about the file, so it is
      // reported and the row records `unverifiable` rather than being punished.
      await reportError({
        scope: "media.verifyVideoDuration",
        error,
        level: "warning",
        extra: { mediaId: args.mediaId },
      });
    }

    const verdict = judgeVideoDuration(measured, VIDEO_MAX_DURATION_SECONDS);
    await ctx.runMutation(mediaFunctions.recordVideoDurationVerdict, {
      mediaId: args.mediaId,
      verdict,
      ...(measured === undefined ? {} : { measuredSeconds: measured }),
    });
    return null;
  },
});

/**
 * Fetch enough of the object to find its `moov`, front first and then back.
 *
 * Two range requests at most. The front covers every file either client
 * produces; the back covers a recorder that wrote `moov` last, which is legal
 * and common for something captured rather than published.
 */
async function measureStoredDuration(
  region: Doc<"media">["storageRegion"],
  key: string,
): Promise<number | undefined> {
  const signed = await resolveStorageAdapter(region).createReadUrl(key, { expiresInSeconds: 120 });

  const head = await fetchRange(signed.url, `bytes=0-${DURATION_PROBE_BYTES - 1}`);
  const fromHead = head === undefined ? undefined : readIsoBmffDuration(head);
  if (fromHead !== undefined) return fromHead.seconds;

  const tail = await fetchRange(signed.url, `bytes=-${DURATION_PROBE_BYTES}`);
  // A tail read starts mid-box, so the walker will usually refuse it — which is
  // correct, and answers `unverifiable` rather than a number read out of frames.
  return tail === undefined ? undefined : readIsoBmffDuration(tail)?.seconds;
}

async function fetchRange(url: string, range: string): Promise<Uint8Array | undefined> {
  const response = await fetch(url, { headers: { Range: range } });
  if (!response.ok) return undefined;
  return new Uint8Array(await response.arrayBuffer());
}

/** The two fields the probe needs. Never a signed URL, never anything else. */
export const mediaForDurationProbe = internalQuery({
  args: { mediaId: v.id("media") },
  returns: v.union(
    v.null(),
    v.object({
      storageKey: v.optional(v.string()),
      storageRegion,
      state: mediaState,
    }),
  ),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.mediaType !== "video" || media.state === "deleted") return null;
    return {
      ...(media.storageKey === undefined ? {} : { storageKey: media.storageKey }),
      storageRegion: media.storageRegion,
      state: media.state,
    };
  },
});

export const recordVideoDurationVerdict = internalMutation({
  args: {
    mediaId: v.id("media"),
    verdict: literalUnion(VIDEO_DURATION_VERDICTS),
    measuredSeconds: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.state === "deleted") return null;
    const now = Date.now();

    if (args.verdict === "overCap") {
      // Tombstone the row and take every object with it, exactly as a withdrawal
      // does — `deleted` is terminal, the counters follow, and any unspent grant
      // for the capture is expired so nothing can attach afterwards.
      const keys = storageKeysOf(media);
      await ctx.db.patch(media._id, {
        state: "deleted",
        deletedAt: now,
        durationVerified: false,
        ...(args.measuredSeconds === undefined ? {} : { durationSeconds: args.measuredSeconds }),
        updatedAt: now,
      });
      await applyCountChange(ctx, media.eventId, media.state, "deleted", now);
      await expireGrantsForCapture(ctx, media.eventId, media.captureId, now);
      if (keys.length > 0) {
        await ctx.scheduler.runAfter(0, mediaFunctions.purgeStoredFile, {
          region: media.storageRegion,
          keys,
          mediaId: media._id,
        });
      } else {
        await ctx.db.patch(media._id, { storageDeletedAt: now });
      }

      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.uploadDiscarded,
        subjectType: "media",
        subjectId: media._id,
        actor: { userId: media.uploaderUserId },
        eventId: media.eventId,
        metadata: {
          captureId: media.captureId,
          reason: "tooLong",
          claimedSeconds: media.durationSeconds ?? null,
          measuredSeconds: args.measuredSeconds ?? null,
          limitSeconds: VIDEO_MAX_DURATION_SECONDS,
        },
        now,
      });
      return null;
    }

    await ctx.db.patch(media._id, {
      durationVerified: args.verdict === "withinCap",
      // The file's own figure replaces the phone's, so the duration a host sees
      // and the one the storage report counts are the measured ones.
      ...(args.verdict === "withinCap" && args.measuredSeconds !== undefined
        ? { durationSeconds: args.measuredSeconds }
        : {}),
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Stamp the moment the bytes actually left, and drop the keys.
 *
 * Dropping them is the point: a tombstoned row that still carries a file key is
 * a row that can still mint a signed URL. After this there is nothing on the
 * record that names an object, which is what makes the read paths safe by
 * construction rather than by remembering to filter.
 *
 * This mutation is called only after the adapter's authoritative `success`
 * acknowledgement. `deleted` is an observation, not the decision: an
 * idempotent retry may remove zero objects because the first call succeeded and
 * its response was lost. In that case the keys are already gone and retaining
 * them forever would manufacture a stuck purge.
 */
export const markStoragePurged = internalMutation({
  args: { mediaId: v.id("media"), deleted: v.number(), requested: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media) return null;
    const now = Date.now();

    const requested = args.requested ?? args.deleted;

    await ctx.db.patch(media._id, {
      storageKey: undefined,
      previewKey: undefined,
      posterKey: undefined,
      storageDeletedAt: now,
      updatedAt: now,
    });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.mediaFilePurged,
      subjectType: "media",
      subjectId: media._id,
      eventId: media.eventId,
      metadata: { deleted: args.deleted, requested, storageRegion: media.storageRegion },
      now,
    });
    return null;
  },
});

/**
 * The provider refused every attempt. Leave the evidence, loudly.
 *
 * No keys are cleared and no timestamp is stamped, so the row stays visible to
 * {@link stuckPurges} and a later retry has something to name. The audit row is
 * the thing an incident is reconstructed from: it is the moment the product's
 * "withdrawal is permanent" promise became false for one item.
 */
export const markStoragePurgeFailed = internalMutation({
  args: {
    mediaId: v.id("media"),
    attempts: v.number(),
    requested: v.number(),
    deleted: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media) return null;
    const now = Date.now();

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.mediaFilePurgeFailed,
      subjectType: "media",
      subjectId: media._id,
      eventId: media.eventId,
      metadata: {
        attempts: args.attempts,
        requested: args.requested,
        deleted: args.deleted,
        storageRegion: media.storageRegion,
        reason: "deleteFailed",
      },
      now,
    });
    await ctx.db.patch(media._id, { updatedAt: now });
    return null;
  },
});

/** Close a durable non-media purge job after every requested key left. */
export const markGenericStoragePurged = internalMutation({
  args: {
    purgeJobId: v.id("storagePurgeJobs"),
    attempts: v.number(),
    requested: v.number(),
    deleted: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.purgeJobId);
    if (!job || job.state === "completed") return null;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      state: "completed",
      attempts: Math.max(job.attempts, args.attempts),
      requested: args.requested,
      deleted: args.deleted,
      keys: undefined,
      lastError: undefined,
      completedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/** Record each failed network attempt while the scheduler still owns retries. */
export const markGenericStoragePurgeAttempt = internalMutation({
  args: { purgeJobId: v.id("storagePurgeJobs"), attempts: v.number(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.purgeJobId);
    if (!job || job.state === "completed" || job.state === "stuck") return null;
    await ctx.db.patch(job._id, {
      attempts: Math.max(job.attempts, args.attempts),
      lastError: args.reason,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Preserve non-media object keys when the bounded delete ladder gives up. */
export const markGenericStoragePurgeFailed = internalMutation({
  args: {
    purgeJobId: v.id("storagePurgeJobs"),
    attempts: v.number(),
    requested: v.number(),
    deleted: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.purgeJobId);
    if (!job || job.state === "completed") return null;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      state: "stuck",
      attempts: Math.max(job.attempts, args.attempts),
      requested: args.requested,
      deleted: args.deleted,
      // A bounded vocabulary only; provider errors and keys never enter it.
      lastError: args.reason,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Withdrawn items whose bytes are still in storage.
 *
 * A tombstoned row with no `storageDeletedAt` is the one shape in this schema
 * that contradicts a promise made to a guest, and until this query existed
 * nothing anywhere asked for it — the sweep ADR 0004 §6 refers to is the P1
 * purge worker, which has not shipped. Four bounded retries plus a Sentry report
 * cover the transient case; this covers the one where they all failed, so a
 * stuck purge is answerable from the host console on the night rather than from
 * a log line nobody read.
 *
 * Host-only and scoped to one event, like `storageStatus`: it names
 * infrastructure and it is a fact about the host's own party. It returns counts
 * and timestamps, never a file key.
 */
export const stuckPurges = query({
  args: { eventId: v.id("events"), limit: v.optional(v.number()) },
  returns: v.object({
    count: v.number(),
    items: v.array(
      v.object({
        id: v.id("media"),
        captureId: v.string(),
        deletedAt: v.optional(v.number()),
        /** How many objects the row still names. Never the keys themselves. */
        outstandingKeys: v.number(),
        storageRegion,
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();

    const rows = await ctx.db
      .query("media")
      .withIndex("by_event_and_state", (q) => q.eq("eventId", args.eventId).eq("state", "deleted"))
      .collect();

    const stuck = rows.filter(
      (row) => row.deletedAt !== undefined && row.storageDeletedAt === undefined,
    );

    return {
      count: stuck.length,
      items: stuck
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
        .slice(0, args.limit ?? 50)
        .map((row) => ({
          id: row._id,
          captureId: row.captureId,
          ...(row.deletedAt === undefined ? {} : { deletedAt: row.deletedAt }),
          outstandingKeys: storageKeysOf(row).length,
          storageRegion: row.storageRegion,
        })),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Read paths                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A guest's own submissions for one event, newest first.
 *
 * Includes `processing`, `pending` and `declined`, because the whole point of
 * the screen is to tell the person who sent it what happened to it. Excludes
 * `deleted`, because they withdrew it.
 *
 * The `media.viewOwn` check is what makes an account state mean something here.
 * `requireEventActor` resolves identity through `requireUser`, not
 * `requireActiveUser` — deliberately, because a locked user must still be able
 * to read their own account and find out why — so without this a `locked` or
 * `deletionScheduled` account kept full access to its media and minted a fresh
 * ten-minute signed URL on every poll. PLAN.md: accounts scheduled for deletion
 * "lose access" immediately, and `accountStateAllows` inside `explainCan` is
 * where that becomes true.
 */
export const myMedia = query({
  args: {
    eventId: v.id("events"),
    // A signed URL expires even when the underlying media row does not change.
    // Clients advance this value before the read TTL, changing the Convex query
    // identity and causing the URLs to be projected again. It deliberately has
    // no business meaning inside the handler.
    urlRefreshKey: v.optional(v.number()),
  },
  returns: v.array(mediaViewValidator),
  handler: async (ctx, args): Promise<MediaView[]> => {
    const actor = await requireEventActor(ctx, args.eventId);

    requirePermission(toPermissionActor(actor.user, actor.role), "media.viewOwn", {
      kind: "media",
      state: "pending",
      isOwn: true,
      event: { state: actor.event.state },
    });

    const rows = await ctx.db
      .query("media")
      .withIndex("by_event_and_uploader", (q) =>
        q.eq("eventId", args.eventId).eq("uploaderUserId", actor.user._id),
      )
      .collect();

    const visible = rows.filter((row) =>
      canSeeMedia(actor.role, { state: row.state, isOwn: true }),
    );
    return await projectAll(ctx, visible, { userId: actor.user._id, role: actor.role });
  },
});

/**
 * An event's media, scoped to what the caller's role may see.
 *
 * The scoping is the contract's (`canSeeMedia`), so the gallery, the moderation
 * queue and the slideshow cannot disagree about who sees a `pending` item. The
 * query is indexed on `eventId` alone and every row is re-checked against the
 * event the actor was resolved for, so there is no shape of argument that
 * returns another party's photographs.
 */
export const eventMedia = query({
  args: {
    eventId: v.id("events"),
    states: v.optional(v.array(mediaState)),
    limit: v.optional(v.number()),
    // See `myMedia`: this cache-buster is intentionally ignored after Convex
    // has used it as part of the subscription arguments.
    urlRefreshKey: v.optional(v.number()),
  },
  returns: v.array(mediaViewValidator),
  handler: async (ctx, args): Promise<MediaView[]> => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(listEventMediaInputSchema, args);

    // Hosts use this query as their moderation queue even before a party is
    // live. Checking `media.viewApproved` for everybody used to reject an owner
    // of a draft or scheduled event because the public gallery is intentionally
    // unavailable in those states. Host access is instead established through
    // `media.viewPending`, which is the capability this screen actually needs.
    //
    // Guests still pass through the approved-gallery check, so a scheduled
    // event does not expose its gallery early. A `globalAdmin` also lands in
    // that branch and is refused because admins have no `media.*` capability.
    if (isHostRole(actor.role)) {
      requirePermission(toPermissionActor(actor.user, actor.role), "media.viewPending", {
        kind: "media",
        state: "pending",
        isOwn: false,
        event: { state: actor.event.state },
      });
    } else {
      requirePermission(toPermissionActor(actor.user, actor.role), "media.viewApproved", {
        kind: "media",
        state: "approved",
        isOwn: false,
        event: { state: actor.event.state },
      });
    }

    // The default is "everything that is not a tombstone", because the *row*
    // filter below is what decides visibility and it needs ownership to do it —
    // a guest's own `pending` item belongs in their view of the gallery, and a
    // state list narrowed by role alone would drop it. `states` is a caller's
    // filter (the moderation queue asks for `pending`), never a security
    // boundary.
    const wanted = new Set<MediaState>(
      input.states ?? MEDIA_STATES.filter((state) => state !== "deleted"),
    );

    const rows = await ctx.db
      .query("media")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();

    // The blocklist is applied **here**, on the gallery, and deliberately not in
    // `myMedia` (which is only ever your own) nor in `moderation.pending` (where
    // it sorts rather than hides — a host must not be able to stall their own
    // queue by blocking somebody). App Review asks that blocked users' content
    // stop appearing for the blocker; it does not ask for it to stop existing.
    const blocked = await loadBlockedUserIds(ctx, actor.user._id);

    const visible = rows.filter(
      (row) =>
        row.eventId === args.eventId &&
        wanted.has(row.state) &&
        !isHiddenByBlock(row, actor.user._id, blocked) &&
        canSeeMedia(actor.role, {
          state: row.state,
          isOwn: row.uploaderUserId === actor.user._id,
        }),
    );

    const limited = visible.sort((a, b) => b.createdAt - a.createdAt).slice(0, input.limit ?? 200);

    return await projectAll(ctx, limited, { userId: actor.user._id, role: actor.role });
  },
});

/**
 * Approved media for an anonymous visitor holding the event's current QR.
 *
 * The token is the access path and is re-checked on every page. Public access
 * exists only after the scheduled end, only while the owner toggle is on, and
 * only for lifecycle states whose approved gallery is otherwise viewable.
 * Pending, declined, processing and deleted rows cannot enter the indexed
 * query at all.
 */
export const publicEventMedia = query({
  args: {
    token: v.string(),
    urlRefreshKey: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(publicMediaViewValidator),
  handler: async (ctx, args) => {
    const parsedToken = inviteTokenSchema.safeParse(args.token);
    if (!parsedToken.success) return emptyPublicPage(args.paginationOpts.cursor);

    const version = await ctx.db
      .query("inviteVersions")
      .withIndex("by_token", (q) => q.eq("token", normalizeInviteToken(parsedToken.data)))
      .unique();
    if (!version || version.status !== "active") {
      return emptyPublicPage(args.paginationOpts.cursor);
    }

    const event = await ctx.db.get(version.eventId);
    if (
      !event ||
      event.publicGalleryEnabled !== true ||
      event.endsAt === undefined ||
      Date.now() <= event.endsAt ||
      !isViewableEventState(event.state) ||
      !(await eventIsUsable(ctx, event))
    ) {
      return emptyPublicPage(args.paginationOpts.cursor);
    }

    const page = await ctx.db
      .query("media")
      .withIndex("by_event_state_and_created", (q) =>
        q.eq("eventId", event._id).eq("state", "approved"),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...page,
      page: await Promise.all(page.page.map((row) => projectPublicMedia(row))),
    };
  },
});

function emptyPublicPage(cursor: string | null) {
  return { page: [], continueCursor: cursor ?? "", isDone: true };
}

async function projectAll(
  ctx: Parameters<typeof projectMedia>[0],
  rows: readonly Doc<"media">[],
  viewer: { userId: Id<"users">; role: Role },
): Promise<MediaView[]> {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const views: MediaView[] = [];
  for (const row of sorted) {
    views.push(
      await projectMedia(ctx, row, { viewerUserId: viewer.userId, viewerRole: viewer.role }),
    );
  }
  return views;
}

/**
 * What the storage seam resolved for an event's region.
 *
 * Diagnostics, not policy: it answers "is this deployment able to store
 * anything?" without leaking a token. Host-only, because a guest has no use for
 * it and it names infrastructure.
 */
export const storageStatus = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    region: storageRegion,
    provider: v.string(),
    configured: v.boolean(),
    appId: v.optional(v.string()),
    callbackConfigured: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();

    const described = resolveStorageAdapter(actor.event.storageRegion).describe();
    return {
      ...described,
      callbackConfigured: envOptional(serverEnv, "UPLOAD_CALLBACK_SECRET") !== undefined,
    };
  },
});
