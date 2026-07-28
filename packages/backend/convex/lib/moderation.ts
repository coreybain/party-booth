import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import {
  mediaStateMachine,
  moderationTransition,
  type ModerationActionName,
  type ModerationRefusal,
} from "@partybooth/contracts/media";
import type { Role } from "@partybooth/contracts/roles";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditEvent } from "./audit";
import { applyCountChange } from "./media";

/**
 * Applying a moderation decision — the one writer of `media.state` on the
 * moderation path.
 *
 * Everything a single decision has to do is here, in one function, because the
 * five things it does have to happen together or not at all:
 *
 * 1. the state moves (through the state machine, which refuses illegal moves
 *    rather than writing them);
 * 2. the event's denormalised counters follow it, in the same transaction, so
 *    the pending badge is exact rather than eventually right;
 * 3. a `moderationDecisions` row is appended — actor, timestamp, prior state —
 *    because "who un-declined this at 1am" is a question that gets asked;
 * 4. `moderatedAt` / `moderatedByUserId` are stamped on the row itself, which is
 *    what the grid sorts and filters by;
 * 5. an immutable audit row is written.
 *
 * The bulk path calls this once per item rather than doing its own thing. A
 * "bulk approve" that took a shortcut through any of the five would be a
 * different feature with the same button, and the first time the two disagreed
 * would be the night forty photos were approved without a decision row.
 *
 * **Idempotence is not an error.** Approving something already approved returns
 * `changed: false` and writes nothing — no second decision row, no second audit
 * line. Two hosts double-tapping the same card is the common case, not the
 * exception.
 */

export type ModerationOutcome =
  | { ok: true; mediaId: Id<"media">; state: Doc<"media">["state"]; changed: boolean }
  | { ok: false; mediaId: Id<"media">; reason: ModerationRefusal; message: string };

export interface ApplyModerationParams {
  media: Doc<"media">;
  action: ModerationActionName;
  actor: { user: Doc<"users">; role: Role };
  reason?: string | undefined;
  now: number;
}

export async function applyModeration(
  ctx: MutationCtx,
  params: ApplyModerationParams,
): Promise<ModerationOutcome> {
  const { media, action, actor, now } = params;

  const transition = moderationTransition(action, media.state);
  if (!transition.ok) {
    return {
      ok: false,
      mediaId: media._id,
      reason: transition.reason,
      message: transition.message,
    };
  }

  if (!transition.changed) {
    return { ok: true, mediaId: media._id, state: media.state, changed: false };
  }

  // The machine, not an `if`. `approved → pending` and anything out of `deleted`
  // are refused here even if a caller talked its way past `moderationTransition`.
  mediaStateMachine.assertTransition(media.state, transition.next);

  await ctx.db.patch(media._id, {
    state: transition.next,
    moderatedAt: now,
    moderatedByUserId: actor.user._id,
    updatedAt: now,
  });
  await applyCountChange(ctx, media.eventId, media.state, transition.next, now);

  await ctx.db.insert("moderationDecisions", {
    mediaId: media._id,
    eventId: media.eventId,
    decision: transition.decision,
    // `host` rather than `automatic`: this function is only ever reached from a
    // human pressing something. Auto-approval happens in `settleAfterProcessing`
    // and writes no decision row, because nobody decided.
    actor: "host",
    decidedByUserId: actor.user._id,
    previousState: media.state,
    ...(params.reason === undefined || params.reason === "" ? {} : { reason: params.reason }),
    createdAt: now,
  });

  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.mediaModerated,
    subjectType: "media",
    subjectId: media._id,
    actor: { userId: actor.user._id, role: actor.role },
    eventId: media.eventId,
    reason: params.reason,
    metadata: {
      captureId: media.captureId,
      moderationAction: action,
      previousState: media.state,
      state: transition.next,
      uploaderUserId: media.uploaderUserId,
    },
    now,
  });

  return { ok: true, mediaId: media._id, state: transition.next, changed: true };
}
