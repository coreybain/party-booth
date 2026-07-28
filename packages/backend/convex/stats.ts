import { eventStatsInputSchema } from "@partybooth/contracts/schemas";
import { SIGNED_HOST_REVIEW_URL_TTL_SECONDS } from "@partybooth/contracts/storage";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { isHiddenByBlock, loadBlockedUserIds } from "./lib/blocks";
import { forbidden } from "./lib/errors";
import { requireEventActor, requirePermission, toPermissionActor } from "./lib/guards";
import { parseInput } from "./lib/input";
import { mediaViewValidator, projectMedia, storedBytesOf, type MediaView } from "./lib/media";
import { mediaState, mediaType } from "./lib/validators";

/**
 * The organiser home screen, in two queries.
 *
 * {@link overview} is numbers and {@link recentSubmissions} is pictures, and
 * they are separate because they have different audiences. A global admin may
 * see how big a party is — that is what `/admin`'s storage and asset columns are
 * — and may **never** see the photographs in it. PLAN.md is explicit ("no media
 * access"), `CAPABILITIES` gives `globalAdmin` no `media.*` action at all, and
 * splitting the two queries is what stops a well-meaning `stats` endpoint
 * quietly becoming the exception.
 *
 * Both are live subscriptions on a screen a host keeps open all evening, so both
 * are indexed and neither mints a signed URL it does not need.
 */

/* -------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* -------------------------------------------------------------------------- */

const overviewValidator = v.object({
  /** The badge. Straight off the event's denormalised counters. */
  pending: v.number(),
  approved: v.number(),
  declined: v.number(),
  /** Everything that is not a tombstone, `processing` included. */
  total: v.number(),
  /** Uploads still in flight — deliberately outside the pending badge. */
  processing: v.number(),
  /** Items a guest has reported and no host has resolved. */
  flagged: v.number(),
  byType: v.object({ photo: v.number(), video: v.number() }),
  byState: v.object({
    processing: v.number(),
    pending: v.number(),
    approved: v.number(),
    declined: v.number(),
  }),
  /** Sum of the byte sizes on the record — originals **and** derivatives. */
  storageBytes: v.number(),
  /** Distinct submitters. `0` for a global admin — see the handler. */
  contributorCount: v.number(),
  /** Per-guest leaderboard. **Empty for a global admin** — see the handler. */
  topContributors: v.array(
    v.object({
      userId: v.id("users"),
      displayName: v.string(),
      approved: v.number(),
      total: v.number(),
    }),
  ),
});

export const overview = query({
  args: {
    eventId: v.id("events"),
    contributorLimit: v.optional(v.number()),
  },
  returns: overviewValidator,
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(eventStatsInputSchema, args);

    // `event.viewStats` is a host power and an admin one. A guest does not have
    // the capability at all, so this throws for them rather than returning an
    // empty shape — "how big is this party" is the host's information.
    requirePermission(toPermissionActor(actor.user, actor.role), "event.viewStats", {
      kind: "event",
      state: actor.event.state,
    });

    const rows = await ctx.db
      .query("media")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();

    const live = rows.filter((row) => row.state !== "deleted");

    const byState = { processing: 0, pending: 0, approved: 0, declined: 0 };
    const byType = { photo: 0, video: 0 };
    const perUser = new Map<string, { approved: number; total: number }>();
    let storageBytes = 0;
    let flagged = 0;

    for (const row of live) {
      if (row.state !== "deleted") byState[row.state] += 1;
      byType[row.mediaType] += 1;
      storageBytes += storedBytesOf(row);
      if (row.flaggedAt !== undefined) flagged += 1;

      const bucket = perUser.get(row.uploaderUserId) ?? { approved: 0, total: 0 };
      bucket.total += 1;
      if (row.state === "approved") bucket.approved += 1;
      perUser.set(row.uploaderUserId, bucket);
    }

    /*
     * The contributor leaderboard is **host information**, and an admin is not a
     * host.
     *
     * `event.viewStats` is in the `globalAdmin` capability set and `eventGate`
     * returns true in every state, so an admin resolving through
     * `requireEventActor` without any membership was enough to read a per-guest
     * breakdown — names, ids, and how much each person photographed — of a
     * stranger's private party. PLAN.md scopes the admin console to "accounts /
     * events / asset counts / storage" with "no media access", and who
     * photographed how much is guest-level personal data rather than an asset
     * count. The aggregate figures the console genuinely needs are untouched;
     * `recentSubmissions` is already split off for the same reason.
     */
    const isHost = actor.role === "owner" || actor.role === "cohost";

    const ranked = isHost
      ? [...perUser.entries()]
          .sort(([, a], [, b]) => b.approved - a.approved || b.total - a.total)
          .slice(0, input.contributorLimit ?? 10)
      : [];

    const topContributors = [];
    for (const [userId, counts] of ranked) {
      const user = await ctx.db.get(userId as Doc<"media">["uploaderUserId"]);
      topContributors.push({
        userId: userId as Doc<"media">["uploaderUserId"],
        displayName: displayNameFor(user),
        approved: counts.approved,
        total: counts.total,
      });
    }

    return {
      // The counters, not a recount: they are maintained inside the mutation
      // that moves each state, so they are exact, and the badge on a host's
      // phone must not disagree with the queue they are about to open.
      pending: actor.event.counts.pending,
      approved: actor.event.counts.approved,
      declined: actor.event.counts.declined,
      total: actor.event.counts.total,
      processing: byState.processing,
      flagged,
      byType,
      byState,
      storageBytes,
      // Zero rather than the real figure for an admin: "how many different
      // people photographed at this private party" is the same kind of fact as
      // the list itself, and the console's own columns are accounts, events,
      // assets and storage.
      contributorCount: isHost ? perUser.size : 0,
      topContributors,
    };
  },
});

/**
 * An uploader's name, anonymised for an account on its way out.
 *
 * The same rule `projectMedia` applies, restated here rather than shared,
 * because sharing it would mean importing a media projection into a counting
 * query — and this one has no media row to project. PLAN.md keeps the
 * submissions and drops the attribution.
 */
function displayNameFor(user: Doc<"users"> | null): string {
  if (!user) return "Someone";
  if (user.accountState === "deletionScheduled" || user.accountState === "deleted") {
    return "Former guest";
  }
  return user.displayName;
}

/* -------------------------------------------------------------------------- */
/* Pictures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The last N submissions with thumbnails, newest first — the strip across the
 * top of the organiser home.
 *
 * Host-only, unlike {@link overview}: it returns signed URLs, so it is a media
 * read path and is gated by a `media.*` capability, which no global admin has.
 * It includes every state a host may see, `processing` included, because "three
 * photos are uploading right now" is exactly the reassurance a host standing
 * next to a guest wants.
 */
export const recentSubmissions = query({
  args: { eventId: v.id("events"), recentLimit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      media: mediaViewValidator,
      state: mediaState,
      mediaType,
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(eventStatsInputSchema, args);

    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();
    requirePermission(toPermissionActor(actor.user, actor.role), "media.viewPending", {
      kind: "media",
      state: "pending",
      isOwn: false,
      event: { state: actor.event.state },
    });

    const rows = await ctx.db
      .query("media")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();

    const blocked = await loadBlockedUserIds(ctx, actor.user._id);
    const visible = rows
      .filter((row) => row.state !== "deleted")
      .filter((row) => !isHiddenByBlock(row, actor.user._id, blocked))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, input.recentLimit ?? 12);

    const items: {
      media: MediaView;
      state: Doc<"media">["state"];
      mediaType: Doc<"media">["mediaType"];
    }[] = [];
    for (const row of visible) {
      items.push({
        media: await projectMedia(ctx, row, {
          viewerUserId: actor.user._id,
          viewerRole: actor.role,
          // Host-only, and it includes `pending` rows. Same short expiry as the
          // moderation queue — a removed host's residual access is a minute.
          expiresInSeconds: SIGNED_HOST_REVIEW_URL_TTL_SECONDS,
        }),
        state: row.state,
        mediaType: row.mediaType,
      });
    }
    return items;
  },
});
