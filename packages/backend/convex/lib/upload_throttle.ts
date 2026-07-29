import {
  canIssueGrant,
  registerGrantIssued,
  type GrantAttemptState,
  type GrantThrottleDecision,
} from "@partybooth/contracts/upload";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";

/**
 * The persistence half of the upload-grant throttle.
 *
 * Same shape as `lib/join_throttle.ts` on purpose — all the policy lives in
 * `@partybooth/contracts/upload` and is pure, and this file only reads and
 * writes `uploadAttempts` rows. Two things differ, and both are deliberate:
 *
 * 1. **It counts successes, not failures.** An issued grant is the scarce
 *    resource here, so the budget is spent by getting one rather than by getting
 *    one wrong.
 * 2. **One key, not several.** Uploading is authenticated *and* requires an
 *    active membership of the named event, so there is nothing to enumerate and
 *    no anonymous axis to defend. The account is the whole attack surface.
 *
 * The read-decide-write happens inside a Convex mutation, which is a
 * serialisable transaction, so two simultaneous grant requests cannot both spend
 * the same budget slot.
 */

function stateOf(row: Doc<"uploadAttempts"> | null): GrantAttemptState | undefined {
  if (!row) return undefined;
  return {
    issuedCount: row.issuedCount,
    windowStartedAt: row.windowStartedAt,
    lastIssuedAt: row.lastIssuedAt,
    ...(row.cooldownUntil === undefined ? {} : { cooldownUntil: row.cooldownUntil }),
  };
}

async function rowFor(ctx: ReadCtx, key: string): Promise<Doc<"uploadAttempts"> | null> {
  return await ctx.db
    .query("uploadAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/** May this account be issued another grant right now? */
export async function checkUploadThrottle(
  ctx: ReadCtx,
  key: string,
  now: number,
): Promise<GrantThrottleDecision> {
  return canIssueGrant(stateOf(await rowFor(ctx, key)), now);
}

/** Charge an issued grant to the account's budget. */
export async function recordGrantIssued(ctx: MutationCtx, key: string, now: number): Promise<void> {
  const existing = await rowFor(ctx, key);
  const next = registerGrantIssued(stateOf(existing), now);

  const fields = {
    issuedCount: next.issuedCount,
    windowStartedAt: next.windowStartedAt,
    lastIssuedAt: next.lastIssuedAt,
    updatedAt: now,
  };

  if (existing) {
    // `undefined` is how Convex removes an optional field, and it has to be
    // passed explicitly: a window that has rolled over must *clear* the spent
    // cooldown rather than leave a value the next read still honours. Only
    // elapsed time produces that state — see `registerGrantIssued`.
    await ctx.db.patch(existing._id, { ...fields, cooldownUntil: next.cooldownUntil });
    return;
  }

  await ctx.db.insert("uploadAttempts", {
    key,
    ...fields,
    ...(next.cooldownUntil === undefined ? {} : { cooldownUntil: next.cooldownUntil }),
  });
}
