import {
  canAttemptJoin,
  registerJoinFailure,
  registerJoinSuccess,
  type JoinAttemptState,
  type JoinThrottleDecision,
} from "@partybooth/contracts";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";

/**
 * The persistence half of the join throttle. All of the policy — how many
 * failures, how long a lockout lasts — lives in `@partybooth/contracts/join`
 * and is pure; this file only reads and writes `joinAttempts` rows.
 *
 * Every call takes an array of keys because a single attempt is throttled on
 * more than one axis: always the account (`user:<id>`), and, where the caller
 * has one, a network key (`net:<hash>`). Any locked key refuses the attempt,
 * and a failure is charged to all of them — one account cycling through
 * addresses and one address cycling through accounts are the same attack.
 */

function stateOf(row: Doc<"joinAttempts"> | null): JoinAttemptState | undefined {
  if (!row) return undefined;
  return {
    failureCount: row.failureCount,
    windowStartedAt: row.windowStartedAt,
    lastAttemptAt: row.lastAttemptAt,
    ...(row.lockedUntil === undefined ? {} : { lockedUntil: row.lockedUntil }),
  };
}

async function rowFor(ctx: ReadCtx, key: string): Promise<Doc<"joinAttempts"> | null> {
  return await ctx.db
    .query("joinAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/**
 * May any of these keys attempt a join right now?
 *
 * Returns the **longest** remaining lockout across the keys, so a client that
 * honours `retryAfterMs` only has to come back once.
 */
export async function checkJoinThrottle(
  ctx: ReadCtx,
  keys: readonly string[],
  now: number,
): Promise<JoinThrottleDecision> {
  let worst = 0;
  for (const key of keys) {
    const decision = canAttemptJoin(stateOf(await rowFor(ctx, key)), now);
    if (!decision.allowed) worst = Math.max(worst, decision.retryAfterMs);
  }
  return worst > 0
    ? { allowed: false, reason: "throttled", retryAfterMs: worst }
    : { allowed: true };
}

async function upsert(
  ctx: MutationCtx,
  key: string,
  next: JoinAttemptState,
  now: number,
): Promise<void> {
  const existing = await rowFor(ctx, key);
  const fields = {
    failureCount: next.failureCount,
    windowStartedAt: next.windowStartedAt,
    lastAttemptAt: next.lastAttemptAt,
    updatedAt: now,
  };

  if (existing) {
    // `undefined` is how Convex removes an optional field, and it has to be
    // passed explicitly: a success must *clear* a lockout, not leave the old
    // value sitting there where the next read would still honour it.
    await ctx.db.patch(existing._id, { ...fields, lockedUntil: next.lockedUntil });
    return;
  }
  await ctx.db.insert("joinAttempts", {
    key,
    ...fields,
    ...(next.lockedUntil === undefined ? {} : { lockedUntil: next.lockedUntil }),
  });
}

/** Charge a failed attempt to every key. */
export async function recordJoinFailure(
  ctx: MutationCtx,
  keys: readonly string[],
  now: number,
): Promise<void> {
  for (const key of keys) {
    await upsert(ctx, key, registerJoinFailure(stateOf(await rowFor(ctx, key)), now), now);
  }
}

/** Hand the budget back on success, so a mistyped code costs nothing long-term. */
export async function recordJoinSuccess(
  ctx: MutationCtx,
  keys: readonly string[],
  now: number,
): Promise<void> {
  for (const key of keys) {
    await upsert(ctx, key, registerJoinSuccess(now), now);
  }
}
