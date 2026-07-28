import { constantTimeEqual } from "@partybooth/contracts/codes";
import {
  allowedMimeTypes,
  canSeeMedia,
  MEDIA_STATES,
  mediaStateMachine,
  type MediaState,
} from "@partybooth/contracts/media";
import { DENIAL_MESSAGES, explainCan } from "@partybooth/contracts/permissions";
import type { Role } from "@partybooth/contracts/roles";
import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import {
  accountGrantKey,
  checkGrantEligibility,
  grantRejected,
  grantSizeCap,
  grantThrottled,
  matchesGrant,
  normaliseMime,
  type GrantResult,
  type UploadCompletionOutcome,
  type UploadRejectionReason,
} from "@partybooth/contracts/upload";
import {
  completeUploadInputSchema,
  confirmUploadInputSchema,
  listEventMediaInputSchema,
  uploadGrantRequestSchema,
  withdrawMediaInputSchema,
} from "@partybooth/contracts/schemas";
import { envOptional, serverEnv } from "@partybooth/env/server";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { forbidden, notFound, unauthenticated } from "./lib/errors";
import {
  requireActiveUser,
  requireEventActor,
  requirePermission,
  toPermissionActor,
  type EventActor,
} from "./lib/guards";
import { parseInput } from "./lib/input";
import {
  applyCountChange,
  ensureMediaRow,
  findMediaByCapture,
  projectMedia,
  settleAfterProcessing,
  type MediaView,
} from "./lib/media";
import { reportError } from "./lib/sentry";
import { resolveStorageAdapter } from "./lib/storage";
import {
  consumeGrant,
  expireGrantsForCapture,
  findGrantBySecret,
  issueGrant,
  linkGrantToMedia,
} from "./lib/upload-grants";
import { checkUploadThrottle, recordGrantIssued } from "./lib/upload-throttle";
import { mediaState, mediaType, storageRegion } from "./lib/validators";

/**
 * The upload spine.
 *
 * Four entry points, in the order a photo travels through them:
 *
 * 1. {@link requestUploadGrant} — the guest asks for permission to send one
 *    exact file. Permission-checked, size-capped, throttled, audited, and
 *    answered with a two-minute single-use secret.
 * 2. {@link confirmUpload} — the client says it finished. Creates the row if the
 *    callback has not already, and asserts nothing about what was stored.
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
 * `npx convex dev` has produced the precise api.
 */
const mediaFunctions = internal.media as unknown as {
  purgeStoredFile: FunctionReference<
    "action",
    "internal",
    {
      region: Doc<"media">["storageRegion"];
      keys: string[];
      mediaId?: Id<"media">;
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
    mediaSource: v.union(v.literal("capture"), v.literal("library")),
    storageRegion,
    byteSize: v.number(),
    maxBytes: v.number(),
    expiresAt: v.number(),
  }),
  v.object({ outcome: v.literal("rejected"), reason: v.string(), message: v.string() }),
  v.object({
    outcome: v.literal("throttled"),
    message: v.string(),
    retryAfterMs: v.number(),
  }),
);

const mediaViewValidator = v.object({
  id: v.id("media"),
  eventId: v.id("events"),
  captureId: v.string(),
  state: mediaState,
  mediaType,
  fromLibrary: v.boolean(),
  byteSize: v.number(),
  mimeType: v.string(),
  durationSeconds: v.optional(v.number()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  uploaderUserId: v.id("users"),
  uploaderDisplayName: v.string(),
  isOwn: v.boolean(),
  createdAt: v.number(),
  capturedAt: v.optional(v.number()),
  uploadedAt: v.optional(v.number()),
  moderatedAt: v.optional(v.number()),
  url: v.optional(v.string()),
  urlExpiresAt: v.optional(v.number()),
  previewUrl: v.optional(v.string()),
  previewUrlExpiresAt: v.optional(v.number()),
});

/* -------------------------------------------------------------------------- */
/* 1. Grants                                                                  */
/* -------------------------------------------------------------------------- */

export const requestUploadGrant = mutation({
  args: {
    eventId: v.id("events"),
    captureId: v.string(),
    mediaType,
    byteSize: v.number(),
    mimeType: v.string(),
    checksum: v.string(),
    durationSeconds: v.optional(v.number()),
    capturedAt: v.optional(v.number()),
    mediaSource: v.optional(v.union(v.literal("capture"), v.literal("library"))),
    fromLibrary: v.optional(v.boolean()),
    /** The client's claim that it re-encoded away EXIF/GPS before uploading. */
    sourceMetadataStripped: v.optional(v.boolean()),
  },
  returns: grantResultValidator,
  handler: async (ctx, args): Promise<GrantResult<Id<"uploadGrants">, Id<"events">>> => {
    // `requireEventActor` hides an event this account has no relationship with
    // behind `notFound`, so an event id cannot be probed from here either.
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot upload right now.");
    }

    const input = parseInput(uploadGrantRequestSchema, args);
    const now = Date.now();

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
      event: { state: actor.event.state },
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
      },
      mediaSource: input.mediaSource,
      file: {
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        durationSeconds: input.durationSeconds,
      },
    });
    if (!eligibility.ok) {
      return await rejectGrant(ctx, {
        actor,
        captureId: input.captureId,
        reason: eligibility.reason,
        now,
      });
    }

    // A capture is uploaded once. A *retry* re-uses the captureId and is the
    // whole point of it; a second file under the same id is not a retry.
    const existing = await findMediaByCapture(ctx, actor.event._id, input.captureId);
    if (existing !== null) {
      // `captureId` is generated by the client and the index is scoped to the
      // event, not to the person — so two guests at one party *can* propose the
      // same id, by accident or on purpose. Whoever got there first keeps it.
      //
      // Without this the resume path below is a hijack: guest B asks for a grant
      // naming guest A's stranded `processing` capture, and `ensureMediaRow`
      // hands B's completion A's row — B's photo, filed under A's name, in A's
      // "my media" list, withdrawable only by A.
      const isOwn = existing.uploaderUserId === actor.user._id;
      const duplicate =
        isOwn && existing.state === "deleted" ? "captureWithdrawn" : "duplicateCapture";

      // The one exception, and only for the person it belongs to: a grant that
      // expired mid-upload leaves a `processing` row with no file, and refusing
      // the retry would strand the guest's photo on their phone for ever.
      const isResumable =
        isOwn && existing.state === "processing" && existing.storageKey === undefined;

      if (!isResumable) {
        return await rejectGrant(ctx, {
          actor,
          captureId: input.captureId,
          reason: duplicate,
          now,
        });
      }
    }

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
      mediaSource: input.mediaSource,
      storageRegion: actor.event.storageRegion,
      byteSize: input.byteSize,
      maxBytes: grantSizeCap(input.mediaType),
      expiresAt: issued.expiresAt,
    };
  },
});

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
): Promise<GrantResult<Id<"uploadGrants">, Id<"events">>> {
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
/* 2. The client says it finished                                             */
/* -------------------------------------------------------------------------- */

/**
 * The client's half of the two-sided completion.
 *
 * It creates the media row if the provider callback has not got here first, and
 * that is **all** it does. It does not consume the grant, set a storage key or
 * move the state, because the client is not a source of truth about what is in
 * storage — only about the fact that it stopped waiting. A guest who lies here
 * gets a `processing` row with no file, which is exactly what a genuinely failed
 * upload looks like.
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
    /** What the grant authorised. `null` only when the grant is unknown. */
    mediaType: v.union(mediaType, v.null()),
    byteSize: v.union(v.number(), v.null()),
    mimeType: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(confirmUploadInputSchema, args);

    const grant = await findGrantBySecret(ctx, input.secret);
    // An unknown or foreign secret is `notFound`, not `forbidden`: the two
    // answers must not tell a caller whether a secret exists.
    if (!grant || grant.userId !== user._id) throw notFound("That upload");

    // Attached to every answer below, including the ones that refuse: the caller
    // that needs them most is the middleware deciding whether to let bytes move.
    const authorised = {
      mediaType: grant.mediaType,
      byteSize: grant.byteSize,
      mimeType: grant.mimeType,
    };

    const existing = await findMediaByCapture(ctx, grant.eventId, grant.captureId);
    if (existing) {
      // Never regress a row the callback has already settled, and never revive a
      // withdrawn one.
      return { mediaId: existing._id, state: existing.state, ...authorised };
    }

    // A grant whose time ran out with nothing stored creates nothing: the client
    // has to ask for a new one, which re-runs every check.
    if (grant.status === "expired" || Date.now() > grant.expiresAt) {
      return { mediaId: null, state: null, ...authorised };
    }

    const now = Date.now();
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
    requireCallbackSecret(args.callbackSecret);
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
      // Expired. The bytes are real and nobody may ever see them.
      return await discard(ctx, {
        grant: consumption.grant,
        fileKey: input.fileKey,
        reason: "expired",
        now,
      });
    }

    const grant = consumption.grant;

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
      allowedMimeTypes(grant.mediaType).includes(normaliseMime(input.mimeType))
        ? normaliseMime(input.mimeType)
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

    const event = await ctx.db.get(grant.eventId);
    if (!event) throw notFound("That event");

    const settled = await ctx.db.get(media._id);
    const state = await settleAfterProcessing(ctx, settled ?? media, event, now);

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
  await ctx.scheduler.runAfter(0, mediaFunctions.purgeStoredFile, {
    region: params.grant.storageRegion,
    keys: [params.fileKey],
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

/**
 * Prove the caller is our own route handler.
 *
 * Constant-time, because the alternative is a comparison whose duration tells an
 * attacker how many characters they have right. `notConfigured` would be the
 * honest error for a deployment with no secret, but it would also tell an
 * unauthenticated caller which deployments are worth coming back to — so an
 * unset secret and a wrong one produce the same refusal.
 */
function requireCallbackSecret(supplied: string): void {
  const expected = envOptional(serverEnv, "UPLOAD_CALLBACK_SECRET");
  if (expected === undefined || !constantTimeEqual(expected, supplied)) {
    throw unauthenticated("This endpoint is not callable from a client.");
  }
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

    const actor = await requireEventActor(ctx, media.eventId);

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

    const keys = [media.storageKey, media.previewKey, media.posterKey].filter(
      (key): key is string => key !== undefined,
    );
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
    /** 1 for the first try. Threaded so the backoff is stateless. */
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    const adapter = resolveStorageAdapter(args.region);

    let deleted: number;
    try {
      ({ deleted } = await adapter.deleteFiles(args.keys));
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
        },
      });

      if (nextDelay !== undefined) {
        await ctx.scheduler.runAfter(nextDelay, mediaFunctions.purgeStoredFile, {
          region: args.region,
          keys: args.keys,
          ...(args.mediaId === undefined ? {} : { mediaId: args.mediaId }),
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
      return null;
    }

    if (deleted < args.keys.length) {
      /*
       * The call succeeded and removed fewer objects than it was handed.
       * UploadThing's `deletedCount` can legitimately be lower on a partial or
       * no-op delete, and the old code stamped the row as purged anyway — which
       * threw away the only record of *which* objects were left behind. Nothing,
       * including the P1 purge worker, could ever find them again.
       */
      await reportError({
        scope: "media.purgeStoredFile",
        error: new Error(`storage delete removed ${deleted} of ${args.keys.length} objects`),
        level: "warning",
        extra: {
          region: args.region,
          keyCount: args.keys.length,
          deleted,
          ...(args.mediaId === undefined ? {} : { mediaId: args.mediaId }),
        },
      });
    }

    if (args.mediaId !== undefined) {
      await ctx.runMutation(mediaFunctions.markStoragePurged, {
        mediaId: args.mediaId,
        deleted,
        requested: args.keys.length,
      });
    }
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
 * **Only on a full delete.** `requested` is the number of keys the action was
 * handed and `deleted` is what the provider says it removed; a short count means
 * at least one object survived, and clearing the keys then would destroy the
 * only pointer to it. On a shortfall the row keeps its keys, keeps `deletedAt`
 * without `storageDeletedAt` — so {@link stuckPurges} lists it — and gets an
 * audit row saying so.
 */
export const markStoragePurged = internalMutation({
  args: { mediaId: v.id("media"), deleted: v.number(), requested: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media) return null;
    const now = Date.now();

    const requested = args.requested ?? args.deleted;
    if (args.deleted < requested) {
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.mediaFilePurgeFailed,
        subjectType: "media",
        subjectId: media._id,
        eventId: media.eventId,
        metadata: {
          deleted: args.deleted,
          requested,
          storageRegion: media.storageRegion,
          reason: "shortDelete",
        },
        now,
      });
      await ctx.db.patch(media._id, { updatedAt: now });
      return null;
    }

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
          outstandingKeys: [row.storageKey, row.previewKey, row.posterKey].filter(
            (key) => key !== undefined,
          ).length,
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
  args: { eventId: v.id("events") },
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
  },
  returns: v.array(mediaViewValidator),
  handler: async (ctx, args): Promise<MediaView[]> => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(listEventMediaInputSchema, args);

    // A `globalAdmin` reaches this via `requireEventActor` without a membership
    // and has no `media.*` capability at all — PLAN.md: admins never look at
    // guests' photos. `visibleMediaStatesFor` gives them the empty set, so this
    // is belt and braces, and it is the belt that produces the right error.
    requirePermission(toPermissionActor(actor.user, actor.role), "media.viewApproved", {
      kind: "media",
      state: "approved",
      isOwn: false,
      event: { state: actor.event.state },
    });

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

    const visible = rows.filter(
      (row) =>
        row.eventId === args.eventId &&
        wanted.has(row.state) &&
        canSeeMedia(actor.role, {
          state: row.state,
          isOwn: row.uploaderUserId === actor.user._id,
        }),
    );

    const limited = visible.sort((a, b) => b.createdAt - a.createdAt).slice(0, input.limit ?? 200);

    return await projectAll(ctx, limited, { userId: actor.user._id, role: actor.role });
  },
});

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
