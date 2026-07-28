import { encodeMediaCursor, decodeMediaCursor, isAfterCursor } from "@partybooth/contracts/media";
import { slideshowInputSchema } from "@partybooth/contracts/schemas";
import { v } from "convex/values";

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
 * {@link encodeMediaCursor} string — `createdAt:id`, total ordering, ties broken
 * by id — and the answer is the items strictly after it plus a `nextCursor` to
 * ask with next time. A re-run with a full cursor returns an empty page, which
 * is cheap, and the client appends rather than rebuilds, which is what keeps the
 * currently-displayed photo on screen instead of restarting the show.
 *
 * **Chronological, always.** Shuffle is a client-side concern: the server's
 * order has to be stable for the cursor to mean anything, and a shuffle that the
 * server did would re-order the whole show every time a photo was approved.
 * PLAN.md's "chronological or shuffle" is one query and two clients.
 */

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

    // Indexed on `(eventId, state, createdAt)` and ordered by it, so the scan
    // starts at the cursor rather than at the beginning of the party.
    const rows = await ctx.db
      .query("media")
      .withIndex("by_event_state_and_created", (q) =>
        cursor === undefined
          ? q.eq("eventId", args.eventId).eq("state", "approved")
          : q
              .eq("eventId", args.eventId)
              .eq("state", "approved")
              .gte("createdAt", cursor.createdAt),
      )
      .collect();

    // The index gets us to the right millisecond; `isAfterCursor` breaks the tie
    // inside it. Both are needed: the range is `gte` because an item sharing the
    // cursor's timestamp but sorting after it by id is still ahead of us.
    const blocked = await loadBlockedUserIds(ctx, actor.user._id);
    const ahead = rows
      .filter((row) => isAfterCursor({ createdAt: row.createdAt, id: row._id }, cursor))
      .filter((row) => !isHiddenByBlock(row, actor.user._id, blocked))
      .sort((a, b) =>
        a.createdAt === b.createdAt ? (a._id < b._id ? -1 : 1) : a.createdAt - b.createdAt,
      );

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
    const nextCursor =
      last === undefined
        ? input.after
        : encodeMediaCursor({ createdAt: last.createdAt, id: last._id });

    const total = await ctx.db
      .query("media")
      .withIndex("by_event_and_state", (q) => q.eq("eventId", args.eventId).eq("state", "approved"))
      .collect();

    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      hasMore: ahead.length > page.length,
      total: total.length,
    };
  },
});
