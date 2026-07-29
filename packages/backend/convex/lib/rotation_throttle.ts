import {
  canRotateInvite,
  registerRotation,
  type RotationAttemptState,
  type RotationDecision,
} from "@partybooth/contracts/codes";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";

/**
 * The persistence half of the invite-rotation budget.
 *
 * Same shape as `lib/upload_throttle.ts` — all the policy is pure and lives in
 * `@partybooth/contracts/codes`, and this file only reads and writes
 * `rotationAttempts` rows. Like the upload one and unlike the join one it counts
 * **successes**, because the rotation is the scarce thing rather than the guess.
 *
 * The key is the **event**, not the account: a party is what a rotation costs,
 * and two co-hosts taking turns on the button must not get two budgets.
 */

export function rotationKey(eventId: Id<"events">): string {
  return `event:${eventId}`;
}

function stateOf(row: Doc<"rotationAttempts"> | null): RotationAttemptState | undefined {
  if (!row) return undefined;
  return {
    count: row.count,
    windowStartedAt: row.windowStartedAt,
    lastRotatedAt: row.lastRotatedAt,
  };
}

async function rowFor(ctx: ReadCtx, key: string): Promise<Doc<"rotationAttempts"> | null> {
  return await ctx.db
    .query("rotationAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

export async function checkRotationThrottle(
  ctx: ReadCtx,
  eventId: Id<"events">,
  now: number,
): Promise<RotationDecision> {
  return canRotateInvite(stateOf(await rowFor(ctx, rotationKey(eventId))), now);
}

/** Charge a completed rotation to the event's budget. */
export async function recordRotation(
  ctx: MutationCtx,
  eventId: Id<"events">,
  now: number,
): Promise<void> {
  const key = rotationKey(eventId);
  const existing = await rowFor(ctx, key);
  const next = registerRotation(stateOf(existing), now);

  const fields = {
    count: next.count,
    windowStartedAt: next.windowStartedAt,
    lastRotatedAt: next.lastRotatedAt,
    updatedAt: now,
  };

  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return;
  }
  await ctx.db.insert("rotationAttempts", { key, ...fields });
}
