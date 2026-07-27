import { AUDIT_ACTIONS } from "@partybooth/contracts";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditEvent } from "./audit";

/**
 * The account-deletion lifecycle.
 *
 * PLAN.md: "accounts move to `deletionScheduled` immediately and lose access",
 * and "the 30-day purge job is post-launch". So deletion at launch is exactly
 * three things — a state change, a `deletionJobs` row recording the intent and
 * the due date, and an audit row — and **nothing** moves an account to
 * `deleted`. That state belongs to the P1 purge worker, which is also what
 * makes the restore window real: an admin can cancel a `scheduled` job right up
 * until it runs.
 *
 * Better Auth's `deleteUser` calls this through the `user.onDelete` trigger in
 * `auth.ts`, which is why it is a plain function rather than a mutation: the
 * trigger already has a mutation context and must stay in the same transaction.
 */

/** How long an account sits in `deletionScheduled` before the purge is due. */
export const ACCOUNT_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ScheduleAccountDeletionOptions {
  /** Absent when the user deleted their own account through Better Auth. */
  requestedByUserId?: Id<"users"> | undefined;
  /** Required by the audit log for account-affecting actions. */
  reason?: string | undefined;
  now?: number | undefined;
}

export interface ScheduleAccountDeletionResult {
  /** `undefined` when the account was already scheduled or already purged. */
  jobId: Id<"deletionJobs"> | undefined;
  scheduledAt: number | undefined;
}

/**
 * Move an account into `deletionScheduled` and record the intent.
 *
 * Idempotent: calling it twice does not create a second job, which matters
 * because Better Auth's delete flow and the (Sprint 5) admin console both end
 * up here.
 */
export async function scheduleAccountDeletion(
  ctx: MutationCtx,
  user: Doc<"users">,
  options: ScheduleAccountDeletionOptions = {},
): Promise<ScheduleAccountDeletionResult> {
  const now = options.now ?? Date.now();

  // Terminal. The purge worker has already been and gone.
  if (user.accountState === "deleted") {
    return { jobId: undefined, scheduledAt: undefined };
  }

  const existingJob = await findScheduledJob(ctx, user._id);
  if (user.accountState === "deletionScheduled" && existingJob) {
    return { jobId: existingJob._id, scheduledAt: existingJob.scheduledAt };
  }

  const scheduledAt = now + ACCOUNT_DELETION_GRACE_MS;

  // Access is revoked by the state alone: every guard goes through
  // `requireActiveUser`, and `accountStateAllows` lets a deletion-scheduled
  // account do nothing but view itself.
  await ctx.db.patch(user._id, {
    accountState: "deletionScheduled",
    deletionScheduledAt: now,
    updatedAt: now,
  });

  const jobId =
    existingJob?._id ??
    (await ctx.db.insert("deletionJobs", {
      subjectType: "user",
      subjectId: user._id,
      state: "scheduled",
      scheduledAt,
      ...(options.requestedByUserId === undefined
        ? {}
        : { requestedByUserId: options.requestedByUserId }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      createdAt: now,
    }));

  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.accountDeletionScheduled,
    subjectType: "user",
    subjectId: user._id,
    ...(options.requestedByUserId === undefined
      ? {}
      : { actor: { userId: options.requestedByUserId } }),
    // `account.deletion_scheduled` is on AUDIT_ACTIONS_REQUIRING_REASON, so a
    // blank reason would throw. Self-service deletion has an implicit one.
    reason: options.reason ?? "Requested by the account holder.",
    metadata: { scheduledAt, previousState: user.accountState },
    now,
  });

  return { jobId, scheduledAt };
}

async function findScheduledJob(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"deletionJobs"> | null> {
  const jobs = await ctx.db
    .query("deletionJobs")
    .withIndex("by_subject", (q) => q.eq("subjectType", "user").eq("subjectId", userId))
    .collect();
  return jobs.find((job) => job.state === "scheduled") ?? null;
}
