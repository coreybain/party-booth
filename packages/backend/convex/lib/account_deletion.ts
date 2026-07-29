import { AUDIT_ACTIONS } from "@partybooth/contracts";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditEvent } from "./audit";
import { expireGrantsForAccount } from "./upload_grants";

/**
 * The account-deletion lifecycle — the **scheduling** half.
 *
 * Requesting deletion is three things: a state change to `deletionScheduled`
 * (which revokes access there and then, because `accountStateAllows` lets such
 * an account do nothing but view itself), a `deletionJobs` row recording the
 * intent and a due date thirty days out, and an audit row.
 *
 * Nothing here moves an account to `deleted`, and that is deliberate: the gap
 * between the two is the restore window, and an admin can cancel a `scheduled`
 * job right up until it runs. What *does* move an account to `deleted` is
 * `convex/deletion.ts`, run daily by `convex/crons.ts` — the erasure worker.
 *
 * **The worker is not optional and it is not post-launch.** It was, and that
 * made this feature indefinite deactivation with a deletion label on the button:
 * no account ever reached `deleted`, the provider credentials stayed live, and
 * the uploads stayed in private storage indefinitely. Apple's account-deletion
 * guideline asks for the account *and its associated data*; Play's data-safety
 * form asks the same question differently. Shipping the button without the
 * worker is a promise the product does not keep.
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

  /*
   * …with one exception, which is why this line exists.
   *
   * An **upload grant** outlives the state change, because `completeUpload`
   * validates the grant rather than the account: it is a capability that was
   * handed out while the answer was still yes. Scheduling deletion is the
   * harsher of the two admin actions — `accountStateAllows` reduces the account
   * to `account.view` — and `admin.lockAccount` already swept grants while this
   * path did not, so the console's own copy ("access is revoked immediately,
   * exactly as a lock does") was true of one route and not the other.
   *
   * It lives here rather than in the admin mutation so that **both** entry
   * points get it: the console and `users.requestAccountDeletion`.
   */
  const expiredGrants = await expireGrantsForAccount(ctx, user._id, now);

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
    metadata: { scheduledAt, previousState: user.accountState, expiredGrants },
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
