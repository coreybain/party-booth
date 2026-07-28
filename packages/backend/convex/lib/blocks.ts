import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";

/**
 * Per-account blocking — the App Review "block abusive users" requirement.
 *
 * The whole feature is one idea: **a block is a filter on the blocker's own
 * reads, and nothing else.** It does not moderate, does not notify, does not
 * revoke a membership and does not change what anybody else sees. That is the
 * only shape that is honest about what a guest is asking for when they press it
 * — "I don't want to see this person" — and it is also the only shape that is
 * safe to hand every member of a party, because it cannot be turned into a
 * weapon against the person blocked.
 *
 * It is deliberately **global rather than per-event**. Someone you have blocked
 * is someone you have blocked; a block that evaporated when the two of you
 * turned up at a second party would not be a block, and explaining that to an
 * App Review reviewer is not a conversation worth having. `userBlocks.eventId`
 * records where it happened for the audit row and is not a scope.
 */

/**
 * Everyone this viewer has blocked.
 *
 * Returned as a `Set` because every caller uses it the same way — once per row
 * in a listing — and because the alternative (a query per item) turns a gallery
 * into N round trips. The list is per-account and small: a guest who has blocked
 * more people than fit in one read is a guest with a different problem.
 */
export async function loadBlockedUserIds(
  ctx: ReadCtx,
  viewerUserId: Id<"users">,
): Promise<ReadonlySet<Id<"users">>> {
  const rows = await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker", (q) => q.eq("blockerUserId", viewerUserId))
    .collect();
  return new Set(rows.map((row) => row.blockedUserId));
}

/**
 * Does this viewer's blocklist hide this item?
 *
 * Their **own** media is never hidden, even in the (impossible-by-mutation, but
 * possible-by-seed) case of a self-block: a guest who cannot see their own
 * submissions cannot withdraw them, and withdrawal is the one control they must
 * never lose.
 */
export function isHiddenByBlock(
  media: Pick<Doc<"media">, "uploaderUserId">,
  viewerUserId: Id<"users">,
  blocked: ReadonlySet<Id<"users">>,
): boolean {
  if (media.uploaderUserId === viewerUserId) return false;
  return blocked.has(media.uploaderUserId);
}

export async function findBlock(
  ctx: ReadCtx,
  blockerUserId: Id<"users">,
  blockedUserId: Id<"users">,
): Promise<Doc<"userBlocks"> | null> {
  return await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker_and_blocked", (q) =>
      q.eq("blockerUserId", blockerUserId).eq("blockedUserId", blockedUserId),
    )
    .unique();
}

/** Idempotent: blocking somebody already blocked changes nothing. */
export async function createBlock(
  ctx: MutationCtx,
  params: {
    blockerUserId: Id<"users">;
    blockedUserId: Id<"users">;
    eventId?: Id<"events"> | undefined;
    now: number;
  },
): Promise<{ created: boolean; blockId: Id<"userBlocks"> }> {
  const existing = await findBlock(ctx, params.blockerUserId, params.blockedUserId);
  if (existing) return { created: false, blockId: existing._id };

  const blockId = await ctx.db.insert("userBlocks", {
    blockerUserId: params.blockerUserId,
    blockedUserId: params.blockedUserId,
    ...(params.eventId === undefined ? {} : { eventId: params.eventId }),
    createdAt: params.now,
  });
  return { created: true, blockId };
}
