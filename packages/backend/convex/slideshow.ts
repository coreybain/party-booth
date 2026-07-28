import { encodeMediaCursor, decodeMediaCursor, isAfterCursor } from "@partybooth/contracts/media";
import { slideshowInputSchema } from "@partybooth/contracts/schemas";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { isHiddenByBlock, loadBlockedUserIds } from "./lib/blocks";
import { requireEventActor, requirePermission, toPermissionActor } from "./lib/guards";
import { parseInput } from "./lib/input";
import { mediaViewValidator, projectMedia, type MediaView } from "./lib/media";

/**
 * The slideshow feed.
 *
 * One query, and everything interesting about it is the cursor.
 *
 * A Convex query re-runs whenever its data changes, which is what makes the
 * slideshow live: approve a photo on a laptop and the television has it a moment
 * later without anybody refreshing anything. The cost is that *every* approval
 * re-runs *this*, all night — so the naive shape ("give me the approved media")
 * re-reads the whole party and re-mints a signed URL per item per approval, and
 * a 200-photo party turns into 200 signed URLs a second by midnight.
 *
 * So the client asks for what it does not have. `after` is a
 * {@link encodeMediaCursor} string — total ordering, ties broken by id — and the
 * answer is the items strictly after it plus a `nextCursor` to ask with next
 * time. A re-run with a full cursor returns an empty page, which is cheap, and
 * the client appends rather than rebuilds, which is what keeps the
 * currently-displayed photo on screen instead of restarting the show.
 *
 * ## The cursor runs on **approval** time, not capture time
 *
 * It used to run on `createdAt`, and that was the wrong clock. `createdAt` is
 * when the photograph was taken; the cursor's job is to describe *what the
 * client has already been sent*, which advances in the order things are
 * **approved**. The two diverge the moment a host works through a backlog: a
 * photo taken at eight and approved at midnight sorts hours behind a cursor that
 * has long since passed it, so it was silently excluded until the five-minute
 * full refresh swept it up. "Approve it and it is on the wall" was true only for
 * items approved in the order they were taken.
 *
 * `media.approvedAt` is stamped by the two things that can approve — a host's
 * decision and `automatic` mode's settle — and `by_event_state_and_approved` is
 * the index over it.
 *
 * ## …and the page is only half the answer
 *
 * A cursor can only ever *add*. It cannot say that a host has just declined,
 * revoked or hidden something, and until it could, the client's playlist was
 * append-only: an item taken off the wall mid-party kept cycling on the
 * television for the rest of the session, holding a signed URL that stayed live
 * for its full ten minutes. That is precisely the remedy `resolveReport` and
 * `moderate` exist to provide, so `approvedIds` is returned alongside the page —
 * the authoritative set, for this viewer, right now — and the client prunes
 * anything absent from it.
 *
 * It is cheap because it is the same scan `total` already did. It is capped at
 * {@link MAX_APPROVED_IDS} so a very large party degrades into "no pruning"
 * rather than into a payload that grows without bound; `approvedIdsComplete`
 * says which of the two the client is holding, and the client only prunes when
 * it is `true`.
 *
 * **Chronological display, always.** Shuffle is a client-side concern, and so is
 * the display order: the server's order has to be stable for the cursor to mean
 * anything, and every item carries `createdAt` for a client that wants to sort
 * by it.
 */

/**
 * How many approved ids one page will carry.
 *
 * Well past any party this product is built for (PLAN.md: 10–50 guests, and the
 * post-launch load target is 1,000 assets). A party larger than this loses live
 * *removal* — never live addition — and the five-minute refresh still catches up.
 */
const MAX_APPROVED_IDS = 2_000;

const slideshowPageValidator = v.object({
  items: v.array(mediaViewValidator),
  /**
   * Where to resume. Absent only when the event has no approved media at all —
   * on an empty page it repeats the cursor that was asked with, so a client
   * never loses its place by polling at a quiet moment.
   */
  nextCursor: v.optional(v.string()),
  /** `true` when the page was capped, so a client knows to ask again at once. */
  hasMore: v.boolean(),
  /** Approved items in the event, ignoring the cursor. For "12 of 240". */
  total: v.number(),
  /**
   * Every approved id this viewer may see, ignoring the cursor.
   *
   * The client reconciles against it: anything it has accumulated that is not in
   * here has been declined, revoked or blocked since, and comes off the wall.
   */
  approvedIds: v.array(v.id("media")),
  /** `false` when the list above was truncated, in which case do not prune. */
  approvedIdsComplete: v.boolean(),
});

export const feed = query({
  args: {
    eventId: v.id("events"),
    after: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: slideshowPageValidator,
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(slideshowInputSchema, args);

    // `event.presentSlideshow` is an owner/cohost power and is gated on the
    // event being viewable. A guest browsing the gallery uses `media.eventMedia`
    // — same rows, different question, and this one puts a party on a television
    // in a room the host controls.
    requirePermission(toPermissionActor(actor.user, actor.role), "event.presentSlideshow", {
      kind: "event",
      state: actor.event.state,
    });

    const cursor = decodeMediaCursor(input.after);
    const blocked = await loadBlockedUserIds(ctx, actor.user._id);

    // One scan, two answers: the authoritative approved set (which the client
    // prunes against) and the page after the cursor. Indexed on
    // `(eventId, state, approvedAt)` and ordered by it.
    const approved = (
      await ctx.db
        .query("media")
        .withIndex("by_event_state_and_approved", (q) =>
          q.eq("eventId", args.eventId).eq("state", "approved"),
        )
        .collect()
    ).filter((row) => !isHiddenByBlock(row, actor.user._id, blocked));

    // The index gets us to the right millisecond; `isAfterCursor` breaks the tie
    // inside it. Both are needed: an item sharing the cursor's timestamp but
    // sorting after it by id is still ahead of us.
    const ahead = approved
      .filter((row) => isAfterCursor(cursorFor(row), cursor))
      .sort((a, b) => compareApproval(a, b));

    const limit = input.limit ?? 60;
    const page = ahead.slice(0, limit);

    const items: MediaView[] = [];
    for (const row of page) {
      items.push(
        await projectMedia(ctx, row, {
          viewerUserId: actor.user._id,
          viewerRole: actor.role,
        }),
      );
    }

    const last = page.at(-1);
    const nextCursor = last === undefined ? input.after : encodeMediaCursor(cursorFor(last));

    const approvedIdsComplete = approved.length <= MAX_APPROVED_IDS;
    const approvedIds = approved.slice(0, MAX_APPROVED_IDS).map((row) => row._id);

    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      hasMore: ahead.length > page.length,
      total: approved.length,
      approvedIds,
      approvedIdsComplete,
    };
  },
});

/**
 * The cursor position of a row.
 *
 * `approvedAt` falls back to `createdAt` for the one shape that can lack it — a
 * row approved before the column existed. Such a row sorts before every stamped
 * one in the index too (Convex orders an absent field first), so the fallback
 * agrees with the scan rather than fighting it, and a cursorless first page
 * carries it regardless.
 */
function cursorFor(row: Doc<"media">): { createdAt: number; id: string } {
  return { createdAt: row.approvedAt ?? row.createdAt, id: row._id };
}

function compareApproval(a: Doc<"media">, b: Doc<"media">): number {
  const left = a.approvedAt ?? a.createdAt;
  const right = b.approvedAt ?? b.createdAt;
  if (left !== right) return left - right;
  return a._id < b._id ? -1 : 1;
}
