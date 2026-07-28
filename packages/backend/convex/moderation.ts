import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import {
  canSeeMedia,
  MODERATION_REFUSALS,
  type ModerationRefusal,
} from "@partybooth/contracts/media";
import {
  moderationActionInputSchema,
  reportMediaInputSchema,
  resolveReportInputSchema,
} from "@partybooth/contracts/schemas";
import { SIGNED_HOST_REVIEW_URL_TTL_SECONDS } from "@partybooth/contracts/storage";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { loadBlockedUserIds } from "./lib/blocks";
import { forbidden, notFound } from "./lib/errors";
import {
  requireActiveUser,
  requireEventActor,
  requireEventActorFor,
  requirePermission,
  toPermissionActor,
} from "./lib/guards";
import { parseInput } from "./lib/input";
import { mediaViewValidator, projectMedia, type MediaView } from "./lib/media";
import { applyModeration, type ModerationOutcome } from "./lib/moderation";
import {
  literalUnion,
  mediaState,
  moderationAction,
  reportReason,
  reportStatus,
} from "./lib/validators";

/**
 * Moderation, and the two App Review surfaces that feed it.
 *
 * Three entry points, and the order matters more than it looks:
 *
 * - {@link moderate} — the host decides. Approve, decline, or take an approval
 *   back. One mutation for one item and for forty, because the grid's single tap
 *   and its "select all and approve" are the same operation.
 * - {@link report} — any member flags somebody else's item. It **does not**
 *   moderate: it raises a flag that puts the item at the top of the host's
 *   queue. Auto-hiding on report would hand any guest a veto over any other
 *   guest's photograph, which is a worse product and a worse party.
 * - {@link resolveReport} — the host says what they did about it, so a report is
 *   a thing that gets answered rather than a thing that accumulates.
 *
 * Everything here writes an audit row and, where a state moved, a
 * `moderationDecisions` row with the prior state on it. Both are append-only.
 */

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

const moderationResultValidator = v.object({
  /** Items whose state actually moved. */
  changed: v.number(),
  /** Items that were already where the action would put them. */
  unchanged: v.number(),
  /** Items the action could not be applied to, with the reason for each. */
  refused: v.array(
    v.object({
      mediaId: v.id("media"),
      reason: literalUnion(MODERATION_REFUSALS),
      message: v.string(),
    }),
  ),
  results: v.array(
    v.object({
      mediaId: v.id("media"),
      state: v.optional(mediaState),
      changed: v.optional(v.boolean()),
    }),
  ),
});

/**
 * Approve, decline or revoke — one item or a selection of them.
 *
 * **Partial success is the contract.** A bulk selection made from a grid that
 * has been live for thirty seconds will contain items another host has already
 * dealt with and items the submitter has withdrawn since. Failing the whole
 * batch on the first of those would mean a host at a party learns that "approve
 * all" is unreliable and stops using it; throwing away the refusals silently
 * would mean they never learn *which* ones did not go through. So every item is
 * attempted, the refusals come back itemised, and the mutation only throws for
 * failures of the **request** — a caller with no permission, an event that is
 * not theirs, an item from another party.
 *
 * That last one is worth stating plainly: every id is re-checked against the
 * event the actor was resolved for. `mediaIds` is a caller-supplied list of
 * document ids, so without that check the argument shape alone would moderate
 * another party's media.
 */
export const moderate = mutation({
  args: {
    eventId: v.id("events"),
    mediaIds: v.array(v.id("media")),
    action: moderationAction,
    reason: v.optional(v.string()),
  },
  returns: moderationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot moderate right now.");
    }
    const input = parseInput(moderationActionInputSchema, args);

    // `media.moderate` is owner/cohost only, and a global admin does not have it
    // at all — admins never look at guests' photos, let alone judge them.
    requirePermission(toPermissionActor(actor.user, actor.role), "media.moderate", {
      kind: "media",
      state: "pending",
      isOwn: false,
      event: { state: actor.event.state },
    });

    const now = Date.now();
    const outcomes: ModerationOutcome[] = [];

    // Sequential rather than `Promise.all`: every one of these patches the same
    // `events.counts` object, and Convex would turn a parallel batch into a pile
    // of write conflicts against itself.
    for (const mediaId of new Set(args.mediaIds)) {
      const media = await ctx.db.get(mediaId);
      if (!media || media.eventId !== args.eventId) throw notFound("That photo");

      outcomes.push(
        await applyModeration(ctx, {
          media,
          action: input.action,
          actor: { user: actor.user, role: actor.role },
          reason: input.reason,
          now,
        }),
      );
    }

    return summarise(outcomes);
  },
});

function summarise(outcomes: readonly ModerationOutcome[]) {
  const refused = outcomes
    .filter((outcome): outcome is Extract<ModerationOutcome, { ok: false }> => !outcome.ok)
    .map((outcome) => ({
      mediaId: outcome.mediaId,
      reason: outcome.reason as ModerationRefusal,
      message: outcome.message,
    }));

  const applied = outcomes.filter(
    (outcome): outcome is Extract<ModerationOutcome, { ok: true }> => outcome.ok,
  );

  return {
    changed: applied.filter((outcome) => outcome.changed).length,
    unchanged: applied.filter((outcome) => !outcome.changed).length,
    refused,
    results: outcomes.map((outcome) =>
      outcome.ok
        ? { mediaId: outcome.mediaId, state: outcome.state, changed: outcome.changed }
        : { mediaId: outcome.mediaId },
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting (App Review)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Report somebody else's media.
 *
 * Available to **any** member — `media.report` is in every event role's
 * capability list — because a reporting flow only a subset of people can reach
 * is not the one Apple's guideline 1.2 asks for.
 *
 * It is idempotent per `(media, reporter)`. Pressing the button twice is one
 * person pressing a button twice, not two complaints, and a count that could be
 * inflated by one determined guest is a count a host cannot triage by.
 *
 * The uploader is never told, and `projectMedia` gives the count to hosts only.
 * A report that notifies its subject is a report nobody dares file.
 */
export const report = mutation({
  args: {
    mediaId: v.id("media"),
    reason: reportReason,
    details: v.optional(v.string()),
  },
  returns: v.object({
    reportId: v.id("mediaReports"),
    created: v.boolean(),
    /**
     * How many members have reported this item. **Hosts only**, exactly as
     * `projectMedia` does it: a guest learning that three other people reported
     * the photo next to theirs is a leak, and a guest who can poll the tally by
     * pressing the button again can watch it tick up the moment a particular
     * person looks at their phone. At a party of thirty that is a meaningful step
     * towards identifying a reporter, which is the one property the whole design
     * protects. The report sheet only ever needed the confirmation.
     */
    reportCount: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(reportMediaInputSchema, args);

    const media = await ctx.db.get(args.mediaId);
    if (!media) throw notFound("That photo");

    // Both refusals say the same thing. `requireEventActor` answers `notFound`
    // for an event the caller has no relationship with precisely so event ids
    // cannot be probed; letting its message through here would undo that one
    // layer up, because a media id the caller holds could then be confirmed to
    // belong to a party they were never invited to.
    const actor = await requireEventActorFor(ctx, media.eventId, "That photo");
    const isOwn = media.uploaderUserId === user._id;

    // The gate refuses `isOwn` — reporting your own upload is meaningless, and
    // `media.withdraw` is the thing that actually removes it — and refuses a
    // `deleted` row, which is already gone.
    requirePermission(toPermissionActor(actor.user, actor.role), "media.report", {
      kind: "media",
      state: media.state,
      isOwn,
      event: { state: actor.event.state },
    });

    // You cannot report what you cannot see. Without this a member could probe
    // for the existence of another guest's pending or declined items by watching
    // which ids this mutation accepts.
    if (!canSeeMedia(actor.role, { state: media.state, isOwn })) throw notFound("That photo");

    const now = Date.now();
    const existing = await ctx.db
      .query("mediaReports")
      .withIndex("by_media_and_reporter", (q) =>
        q.eq("mediaId", media._id).eq("reporterUserId", user._id),
      )
      .unique();

    const isHost = actor.role === "owner" || actor.role === "cohost";

    if (existing) {
      return {
        reportId: existing._id,
        created: false,
        ...(isHost ? { reportCount: media.reportCount ?? 1 } : {}),
      };
    }

    const reportId = await ctx.db.insert("mediaReports", {
      mediaId: media._id,
      eventId: media.eventId,
      reporterUserId: user._id,
      reason: input.reason,
      ...(input.details === undefined ? {} : { details: input.details }),
      status: "open",
      createdAt: now,
      updatedAt: now,
    });

    const reportCount = (media.reportCount ?? 0) + 1;
    await ctx.db.patch(media._id, {
      reportCount,
      flaggedAt: media.flaggedAt ?? now,
      updatedAt: now,
    });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.mediaReported,
      subjectType: "media",
      subjectId: media._id,
      actor: { userId: user._id, role: actor.role },
      eventId: media.eventId,
      // The reporter's free text is **not** here. An audit row is read by people
      // who were not part of the conversation, and the reason enum is enough to
      // reconstruct what happened.
      metadata: {
        captureId: media.captureId,
        reason: input.reason,
        mediaState: media.state,
        reportCount,
      },
      now,
    });

    return { reportId, created: true, ...(isHost ? { reportCount } : {}) };
  },
});

/**
 * Close a report: the host either acted on it or looked and disagreed.
 *
 * Resolving the **last** open report clears `flaggedAt`, so the flagged queue
 * means "somebody is waiting on a host" rather than "somebody once complained".
 * `reportCount` is left alone: it is the history, and a host deciding an item is
 * fine does not un-report it.
 */
export const resolveReport = mutation({
  args: {
    reportId: v.id("mediaReports"),
    status: literalUnion(["actioned", "dismissed"] as const),
    reason: v.optional(v.string()),
  },
  returns: v.object({ status: reportStatus, stillFlagged: v.boolean() }),
  handler: async (ctx, args) => {
    const input = parseInput(resolveReportInputSchema, args);

    const report_ = await ctx.db.get(args.reportId);
    if (!report_) throw notFound("That report");

    const actor = await requireEventActor(ctx, report_.eventId);
    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();
    // The gate `moderate` already has, and this is the same kind of write: a
    // host whose account is `locked` or `deletionScheduled` must not keep
    // resolving other people's reports. `requireEventActor` resolves through
    // `requireUser`, not `requireActiveUser`, deliberately — so the state has to
    // be checked here or not at all.
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot moderate right now.");
    }

    const now = Date.now();
    if (report_.status === "open") {
      await ctx.db.patch(report_._id, {
        status: input.status,
        resolvedAt: now,
        resolvedByUserId: actor.user._id,
        updatedAt: now,
      });
    }

    const open = await ctx.db
      .query("mediaReports")
      .withIndex("by_media", (q) => q.eq("mediaId", report_.mediaId))
      .collect();
    const stillFlagged = open.some((row) => row._id !== report_._id && row.status === "open");

    if (!stillFlagged) {
      await ctx.db.patch(report_.mediaId, { flaggedAt: undefined, updatedAt: now });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.mediaReportResolved,
      subjectType: "media",
      subjectId: report_.mediaId,
      actor: { userId: actor.user._id, role: actor.role },
      eventId: report_.eventId,
      reason: input.reason,
      metadata: { status: input.status, reportReason: report_.reason },
      now,
    });

    return { status: input.status, stillFlagged };
  },
});

/* -------------------------------------------------------------------------- */
/* The host's queues                                                          */
/* -------------------------------------------------------------------------- */

const flaggedItemValidator = v.object({
  media: mediaViewValidator,
  reports: v.array(
    v.object({
      id: v.id("mediaReports"),
      reason: reportReason,
      status: reportStatus,
      details: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
});

/**
 * Reported items, newest complaint first, with the complaints attached.
 *
 * Host-only, and it returns the reporters' free text — which is the one place
 * that text is ever shown, to the one audience that has to read it. It does not
 * return **who** reported: a host who knows which guest reported which other
 * guest is a host who can be asked to take sides, and the report is about the
 * content.
 */
export const flagged = query({
  args: { eventId: v.id("events"), limit: v.optional(v.number()) },
  returns: v.array(flaggedItemValidator),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();

    /*
     * The same gate `pending` applies, and for the same reason.
     *
     * A bare role check routes around `accountStateAllows`, which is the only
     * thing that makes `locked` and `deletionScheduled` mean anything. Without
     * it a host on their way out of the product kept full read access to every
     * reported item — including freshly minted ten-minute signed URLs to the
     * **originals**, because `projectMedia` with `viewerRole: "owner"` bypasses
     * `mayServeOriginal`. PLAN.md: those accounts "lose access" immediately.
     */
    requirePermission(toPermissionActor(actor.user, actor.role), "media.viewPending", {
      kind: "media",
      state: "pending",
      isOwn: false,
      event: { state: actor.event.state },
    });

    /*
     * Open reports only, and indexed on `(event, status)` rather than filtered
     * after the fact.
     *
     * Grouping every report the event has ever had meant an item stayed in the
     * flagged panel for ever once its last report was resolved: `flaggedAt` was
     * cleared, so `resolveReport` had nothing left to offer, and the card sat
     * there with no buttons on it for the rest of the party.
     */
    const reports = await ctx.db
      .query("mediaReports")
      .withIndex("by_event_and_status", (q) => q.eq("eventId", args.eventId).eq("status", "open"))
      .collect();

    const byMedia = new Map<Id<"media">, Doc<"mediaReports">[]>();
    for (const row of reports) {
      const bucket = byMedia.get(row.mediaId);
      if (bucket) bucket.push(row);
      else byMedia.set(row.mediaId, [row]);
    }

    const items: { media: MediaView; reports: Doc<"mediaReports">[]; latest: number }[] = [];
    for (const [mediaId, rows] of byMedia) {
      const media = await ctx.db.get(mediaId);
      // A withdrawn item's reports stay in the table for the audit trail but
      // leave the queue: there is nothing left for a host to decide.
      if (!media || media.state === "deleted") continue;

      items.push({
        media: await projectMedia(ctx, media, {
          viewerUserId: actor.user._id,
          viewerRole: actor.role,
          // A host-only surface serving `pending` originals: short expiry, so a
          // co-host removed a moment ago keeps them for a minute, not ten.
          expiresInSeconds: SIGNED_HOST_REVIEW_URL_TTL_SECONDS,
        }),
        reports: rows,
        latest: Math.max(...rows.map((row) => row.createdAt)),
      });
    }

    return items
      .sort((a, b) => b.latest - a.latest)
      .slice(0, args.limit ?? 100)
      .map((item) => ({
        media: item.media,
        reports: item.reports
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((row) => ({
            id: row._id,
            reason: row.reason,
            status: row.status,
            ...(row.details === undefined ? {} : { details: row.details }),
            createdAt: row.createdAt,
          })),
      }));
  },
});

/**
 * The pending queue: what a host has to look at, oldest first.
 *
 * Oldest first on purpose, and it is the opposite of every other listing in the
 * product. A gallery shows the newest thing because that is what people want to
 * see; a queue shows the oldest because that is the guest who has been waiting
 * longest to find out whether their photo made it onto the wall.
 *
 * The blocklist is applied here too. A host who blocked somebody still has to be
 * able to moderate them — otherwise blocking would be a way to stall a queue —
 * so what this does is *sort them last*, never hide them. Nothing a host must
 * act on is ever removed from a host's own queue by a filter they set.
 */
export const pending = query({
  args: { eventId: v.id("events"), limit: v.optional(v.number()) },
  returns: v.array(mediaViewValidator),
  handler: async (ctx, args): Promise<MediaView[]> => {
    const actor = await requireEventActor(ctx, args.eventId);

    requirePermission(toPermissionActor(actor.user, actor.role), "media.viewPending", {
      kind: "media",
      state: "pending",
      isOwn: false,
      event: { state: actor.event.state },
    });

    const rows = await ctx.db
      .query("media")
      .withIndex("by_event_and_state", (q) => q.eq("eventId", args.eventId).eq("state", "pending"))
      .collect();

    const blocked = await loadBlockedUserIds(ctx, actor.user._id);
    const ordered = [...rows].sort((a, b) => {
      // Flagged items first — somebody is actively waiting on a decision — then
      // blocked-uploader items last, then oldest first.
      const flagRank = Number(b.flaggedAt !== undefined) - Number(a.flaggedAt !== undefined);
      if (flagRank !== 0) return flagRank;
      const blockRank =
        Number(blocked.has(a.uploaderUserId)) - Number(blocked.has(b.uploaderUserId));
      if (blockRank !== 0) return blockRank;
      return a.createdAt - b.createdAt;
    });

    const views: MediaView[] = [];
    for (const row of ordered.slice(0, args.limit ?? 200)) {
      views.push(
        await projectMedia(ctx, row, {
          viewerUserId: actor.user._id,
          viewerRole: actor.role,
          // See `moderation.flagged`: the queue is the other place a host is
          // handed originals nobody else may ever see.
          expiresInSeconds: SIGNED_HOST_REVIEW_URL_TTL_SECONDS,
        }),
      );
    }
    return views;
  },
});
