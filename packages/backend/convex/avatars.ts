import {
  AVATAR_GRANT_POLICY,
  avatarUploadRequestSchema,
  type AvatarUploadCompletionResult,
} from "@partybooth/contracts/avatar";
import { normaliseMime } from "@partybooth/contracts/upload";
import { serverEnv } from "@partybooth/env/server";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { consumeAvatarGrant, issueAvatarGrant, startAvatarGrant } from "./lib/avatar_grants";
import { notFound, rateLimited } from "./lib/errors";
import { requireActiveUser } from "./lib/guards";
import { parseInput } from "./lib/input";
import { createStoragePurgeJob, type GenericStoragePurgeSource } from "./lib/storage_purge";
import { requireUploadCallbackSecret } from "./lib/upload_callback";

/** Reuse the storage adapter's retrying deletion action without exposing keys. */
const storageFunctions = internal.media as unknown as {
  purgeStoredFile: FunctionReference<
    "action",
    "internal",
    {
      region: Doc<"avatarUploadGrants">["storageRegion"];
      keys: string[];
      purgeJobId?: Id<"storagePurgeJobs">;
      attempt?: number;
    },
    null
  >;
};

const issuedAvatarGrantValidator = v.object({
  secret: v.string(),
  expiresAt: v.number(),
  byteSize: v.number(),
  mimeType: v.literal("image/jpeg"),
  checksum: v.string(),
});

/** Bind one exact re-encoded JPEG to this active account for two minutes. */
export const requestUploadGrant = mutation({
  args: {
    byteSize: v.number(),
    mimeType: v.string(),
    checksum: v.string(),
  },
  returns: issuedAvatarGrantValidator,
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(avatarUploadRequestSchema, args);
    const now = Date.now();

    // Avatar changes are rare. Ten grants in five minutes is generous for an
    // honest retry loop and puts a hard bound on authenticated storage churn.
    const recent = await ctx.db
      .query("avatarUploadGrants")
      .withIndex("by_user_and_issuedAt", (q) =>
        q.eq("userId", user._id).gte("issuedAt", now - AVATAR_GRANT_POLICY.windowMs),
      )
      .order("asc")
      .collect();
    if (recent.length >= AVATAR_GRANT_POLICY.maxPerWindow) {
      const oldest = recent[0]?.issuedAt ?? now;
      throw rateLimited(
        "Too many profile photo attempts. Wait a moment and try again.",
        Math.max(1, oldest + AVATAR_GRANT_POLICY.windowMs - now),
      );
    }

    const issued = await issueAvatarGrant(ctx, {
      userId: user._id,
      storageRegion: serverEnv.STORAGE_DEFAULT_REGION,
      byteSize: input.byteSize,
      mimeType: input.mimeType,
      checksum: input.checksum,
      now,
    });

    return {
      secret: issued.secret,
      expiresAt: issued.expiresAt,
      byteSize: input.byteSize,
      mimeType: input.mimeType,
      checksum: input.checksum,
    };
  },
});

/**
 * Authenticated UploadThing middleware preflight.
 *
 * It atomically reserves but does not consume. The TTL governs reaching this
 * authenticated preflight; a provider callback may complete afterwards.
 * Unknown, foreign, expired and replayed secrets deliberately share a not-found
 * answer, so one capability cannot mint two provider URLs.
 */
export const confirmUpload = mutation({
  args: { secret: v.string() },
  returns: v.object({ byteSize: v.number(), mimeType: v.string(), checksum: v.string() }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const reservation = await startAvatarGrant(ctx, args.secret, user._id, Date.now());
    if (!reservation.ok) throw notFound("That upload");
    const grant = reservation.grant;
    return { byteSize: grant.byteSize, mimeType: grant.mimeType, checksum: grant.checksum };
  },
});

const completionValidator = v.object({
  outcome: v.union(
    v.literal("registered"),
    v.literal("duplicate"),
    v.literal("discarded"),
    v.literal("rejected"),
  ),
  reason: v.optional(v.string()),
});

/**
 * Server-only completion. This is the only path allowed to place a provider
 * key on a user row, and it requires both the grant secret and the callback
 * secret held by the web route.
 */
export const completeUpload = mutation({
  args: {
    callbackSecret: v.string(),
    secret: v.string(),
    fileKey: v.string(),
    byteSize: v.number(),
    mimeType: v.string(),
    checksum: v.string(),
  },
  returns: completionValidator,
  handler: async (ctx, args): Promise<AvatarUploadCompletionResult> => {
    requireUploadCallbackSecret(args.callbackSecret);
    const now = Date.now();
    const consumption = await consumeAvatarGrant(ctx, args.secret, args.fileKey, now);

    if (!consumption.ok) {
      if (consumption.reason === "unknownGrant") {
        // With no trusted row there is no trusted region. Do not turn a leaked
        // callback secret into an arbitrary provider-key deletion primitive.
        return { outcome: "rejected", reason: "unknownGrant" };
      }
      if (consumption.reason === "alreadyConsumed") {
        if (consumption.grant.consumedFileKey === args.fileKey) {
          return { outcome: "duplicate" };
        }
        await purge(ctx, consumption.grant.storageRegion, args.fileKey, "rejectedUpload", now);
        return { outcome: "rejected", reason: "alreadyConsumed" };
      }
      await purge(ctx, consumption.grant.storageRegion, args.fileKey, "rejectedUpload", now);
      return { outcome: "discarded", reason: consumption.reason };
    }

    const grant = consumption.grant;
    const matches =
      args.byteSize === grant.byteSize &&
      normaliseMime(args.mimeType) === normaliseMime(grant.mimeType) &&
      args.checksum === grant.checksum;
    if (!matches) {
      await purge(ctx, grant.storageRegion, args.fileKey, "rejectedUpload", now);
      return { outcome: "discarded", reason: "fileMismatch" };
    }

    const user = await ctx.db.get(grant.userId);
    if (!user || user.accountState !== "active") {
      await purge(ctx, grant.storageRegion, args.fileKey, "rejectedUpload", now);
      return { outcome: "discarded", reason: "accountUnavailable" };
    }

    const previousKey = user.avatarKey;
    const previousRegion = user.avatarStorageRegion ?? serverEnv.STORAGE_DEFAULT_REGION;
    await ctx.db.patch(user._id, {
      avatarKey: args.fileKey,
      avatarStorageRegion: grant.storageRegion,
      updatedAt: now,
    });

    if (previousKey !== undefined && previousKey !== args.fileKey) {
      await purge(ctx, previousRegion, previousKey, "avatarReplacement", now);
    }
    return { outcome: "registered" };
  },
});

async function purge(
  ctx: MutationCtx,
  region: Doc<"avatarUploadGrants">["storageRegion"],
  key: string,
  source: GenericStoragePurgeSource,
  now: number,
): Promise<void> {
  const purgeJobId = await createStoragePurgeJob(ctx, { region, keys: [key], source, now });
  await ctx.scheduler.runAfter(0, storageFunctions.purgeStoredFile, {
    region,
    keys: [key],
    purgeJobId,
  });
}

export type AvatarUploadGrantId = Id<"avatarUploadGrants">;
