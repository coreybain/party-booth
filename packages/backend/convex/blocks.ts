import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import { blockUserInputSchema, unblockUserInputSchema } from "@partybooth/contracts/schemas";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { createBlock, findBlock } from "./lib/blocks";
import { invalidInput, notFound } from "./lib/errors";
import { requireActiveUser, requireEventActor } from "./lib/guards";
import { parseInput } from "./lib/input";

/**
 * Blocking another guest — App Review's "block abusive users".
 *
 * See `lib/blocks.ts` for what a block *is*: a filter on the blocker's own
 * reads, per-account and global, invisible to the person blocked. These three
 * functions are only the door to it.
 *
 * Two things are deliberately absent, and both were tempting:
 *
 * - **No notification and no visible effect for the blocked account.** A block
 *   that tells its subject is a block a guest at a small party will not use,
 *   which makes the feature decorative exactly when it is needed.
 * - **No membership change.** Blocking is not ejecting. A guest cannot remove
 *   another guest from a host's party by pressing a button on their own phone;
 *   `membership.revoke` is a host power and stays one.
 */

export const block = mutation({
  args: { eventId: v.id("events"), userId: v.id("users") },
  returns: v.object({ blocked: v.boolean(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    parseInput(blockUserInputSchema, args);

    // Resolved through the event so a stranger cannot use this to test whether
    // an account id exists — same reasoning as every other event-scoped path.
    const actor = await requireEventActor(ctx, args.eventId);

    if (args.userId === user._id) {
      throw invalidInput("You cannot block yourself.");
    }

    const target = await ctx.db.get(args.userId);
    if (!target) throw notFound("That guest");

    const now = Date.now();
    const { created } = await createBlock(ctx, {
      blockerUserId: user._id,
      blockedUserId: args.userId,
      eventId: args.eventId,
      now,
    });

    if (created) {
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.userBlocked,
        subjectType: "user",
        subjectId: args.userId,
        actor: { userId: user._id, role: actor.role },
        eventId: args.eventId,
        // No names, no addresses. Two ids and the party they were both at.
        metadata: { blockedUserId: args.userId },
        now,
      });
    }

    return { blocked: true, created };
  },
});

export const unblock = mutation({
  args: { userId: v.id("users") },
  returns: v.object({ blocked: v.boolean(), removed: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    parseInput(unblockUserInputSchema, args);

    const existing = await findBlock(ctx, user._id, args.userId);
    if (!existing) return { blocked: false, removed: false };

    // The one hard delete in the product, and it is correct here: a block is a
    // preference, not a record of anything that happened, and a tombstoned
    // preference is a preference that still filters. The audit row is what
    // survives.
    await ctx.db.delete(existing._id);

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.userUnblocked,
      subjectType: "user",
      subjectId: args.userId,
      actor: { userId: user._id },
      ...(existing.eventId === undefined ? {} : { eventId: existing.eventId }),
      metadata: { blockedUserId: args.userId },
      now: Date.now(),
    });

    return { blocked: false, removed: true };
  },
});

/**
 * Who this account has blocked, for the Settings screen App Review looks for.
 *
 * Returns display names because the list is unusable without them and the viewer
 * has already seen every one of these people at a party. It returns no email
 * addresses, and it is readable only by the blocker.
 */
export const myBlocks = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.id("users"),
      displayName: v.string(),
      eventId: v.optional(v.id("events")),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const user = await requireActiveUser(ctx);

    const rows = await ctx.db
      .query("userBlocks")
      .withIndex("by_blocker", (q) => q.eq("blockerUserId", user._id))
      .collect();

    const items = [];
    for (const row of rows.sort((a, b) => b.createdAt - a.createdAt)) {
      const blocked = await ctx.db.get(row.blockedUserId);
      items.push({
        userId: row.blockedUserId,
        displayName: blocked?.displayName ?? "Someone",
        ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
        createdAt: row.createdAt,
      });
    }
    return items;
  },
});
