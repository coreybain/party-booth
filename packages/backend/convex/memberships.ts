import {
  AUDIT_ACTIONS,
  guestAutoApproveInputSchema,
  guestMembershipActionInputSchema,
} from "@partybooth/contracts";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { forbidden, notFound } from "./lib/errors";
import { requireEventActor, requirePermission, toPermissionActor } from "./lib/guards";
import { parseInput } from "./lib/input";
import { expireGrantsForUser } from "./lib/upload_grants";

const guestMemberValidator = v.object({
  membershipId: v.id("memberships"),
  userId: v.id("users"),
  displayName: v.string(),
  joinedAt: v.number(),
  autoApproveMedia: v.boolean(),
  submissionCount: v.number(),
  approvedCount: v.number(),
});

/**
 * The event's active guests, with enough activity data for both the organiser
 * dashboard and the guest-management sheet.
 *
 * Global admins deliberately get nothing here. They may inspect membership
 * rows from the support console, but a named per-guest upload count is private
 * party activity and follows the same host-only boundary as the contributor
 * leaderboard in stats.overview.
 */
export const guests = query({
  args: { eventId: v.id("events") },
  returns: v.array(guestMemberValidator),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();

    requirePermission(toPermissionActor(actor.user, actor.role), "membership.list", {
      kind: "membership",
      targetRole: "guest",
      isSelf: false,
      event: { state: actor.event.state },
    });

    const memberships = (
      await ctx.db
        .query("memberships")
        .withIndex("by_event_and_role", (q) => q.eq("eventId", args.eventId).eq("role", "guest"))
        .collect()
    ).filter((membership) => membership.status === "active");

    const media = await ctx.db
      .query("media")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();
    const activity = new Map<string, { approved: number; total: number }>();
    for (const item of media) {
      if (item.state === "deleted") continue;
      const current = activity.get(item.uploaderUserId) ?? { approved: 0, total: 0 };
      current.total += 1;
      if (item.state === "approved") current.approved += 1;
      activity.set(item.uploaderUserId, current);
    }

    const result = [];
    for (const membership of memberships) {
      const user = await ctx.db.get(membership.userId);
      const counts = activity.get(membership.userId) ?? { approved: 0, total: 0 };
      result.push({
        membershipId: membership._id,
        userId: membership.userId,
        displayName: displayNameFor(user),
        joinedAt: membership.joinedAt,
        autoApproveMedia: membership.autoApproveMedia === true,
        submissionCount: counts.total,
        approvedCount: counts.approved,
      });
    }

    return result.sort((a, b) => b.joinedAt - a.joinedAt);
  },
});

/** Let one trusted guest's future uploads bypass the manual queue. */
export const setAutoApprove = mutation({
  args: { eventId: v.id("events"), userId: v.id("users"), enabled: v.boolean() },
  returns: v.object({ enabled: v.boolean() }),
  handler: async (ctx, args) => {
    const input = parseInput(guestAutoApproveInputSchema, args);
    const actor = await requireEventActor(ctx, args.eventId);

    requirePermission(toPermissionActor(actor.user, actor.role), "media.moderate", {
      kind: "media",
      state: "pending",
      isOwn: false,
      event: { state: actor.event.state },
    });

    const membership = await activeGuestMembership(ctx, args.eventId, args.userId);
    if (membership.autoApproveMedia === input.enabled) return { enabled: input.enabled };

    const now = Date.now();
    await ctx.db.patch(membership._id, {
      autoApproveMedia: input.enabled ? true : undefined,
    });
    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.membershipAutoApproveChanged,
      subjectType: "membership",
      subjectId: membership._id,
      actor: { userId: actor.user._id, role: actor.role },
      eventId: actor.event._id,
      metadata: { enabled: input.enabled, guestUserId: membership.userId },
      now,
    });

    return { enabled: input.enabled };
  },
});

/**
 * Remove or ban a guest.
 *
 * Both revoke the current seat and every outstanding upload grant. A removal
 * records rejoinAllowed true; a ban records false, so the existing join
 * evaluator can make the distinction before it reveals any event details.
 */
export const removeGuest = mutation({
  args: {
    eventId: v.id("events"),
    userId: v.id("users"),
    action: v.union(v.literal("remove"), v.literal("ban")),
    reason: v.string(),
  },
  returns: v.object({
    revoked: v.boolean(),
    rejoinAllowed: v.boolean(),
    expiredGrants: v.number(),
  }),
  handler: async (ctx, args) => {
    const input = parseInput(guestMembershipActionInputSchema, args);
    const actor = await requireEventActor(ctx, args.eventId);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_event_and_user", (q) =>
        q.eq("eventId", args.eventId).eq("userId", args.userId),
      )
      .unique();
    if (!membership || membership.role !== "guest") throw notFound("That guest");

    requirePermission(toPermissionActor(actor.user, actor.role), "membership.revoke", {
      kind: "membership",
      targetRole: membership.role,
      isSelf: membership.userId === actor.user._id,
      event: { state: actor.event.state },
    });

    const rejoinAllowed = input.action === "remove";
    const alreadyDecided =
      membership.status === "revoked" &&
      membership.revokedByRotation !== true &&
      membership.rejoinAllowed === rejoinAllowed;
    if (alreadyDecided || (membership.status === "revoked" && input.action === "remove")) {
      return { revoked: false, rejoinAllowed: membership.rejoinAllowed === true, expiredGrants: 0 };
    }

    const now = Date.now();
    await ctx.db.patch(membership._id, {
      status: "revoked",
      revokedAt: now,
      revokedByUserId: actor.user._id,
      revokeReason: input.reason,
      revokedByRotation: false,
      rejoinAllowed,
      autoApproveMedia: undefined,
    });
    const expiredGrants = await expireGrantsForUser(ctx, args.eventId, args.userId, now);

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.membershipRevoked,
      subjectType: "membership",
      subjectId: membership._id,
      actor: { userId: actor.user._id, role: actor.role },
      eventId: args.eventId,
      reason: input.reason,
      metadata: {
        via: "guestManager",
        action: input.action,
        revokedUserId: membership.userId,
        rejoinAllowed,
      },
      now,
    });

    return { revoked: true, rejoinAllowed, expiredGrants };
  },
});

async function activeGuestMembership(
  ctx: Parameters<typeof requireEventActor>[0],
  eventId: Doc<"memberships">["eventId"],
  userId: Doc<"memberships">["userId"],
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", userId))
    .unique();
  if (!membership || membership.role !== "guest" || membership.status !== "active") {
    throw notFound("That guest");
  }
  return membership;
}

function displayNameFor(user: Doc<"users"> | null): string {
  if (!user) return "Someone";
  if (user.accountState === "deletionScheduled" || user.accountState === "deleted") {
    return "Former guest";
  }
  return user.displayName;
}
