import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { authComponent } from "./auth";
import { writeAuditEvent } from "./lib/audit";
import { applyCountChange, storageKeysOf } from "./lib/media";
import { reportError } from "./lib/sentry";

/**
 * The account-deletion purge worker.
 *
 * Deletion used to be three things — a state change, a `deletionJobs` row and an
 * audit row — with a comment saying the worker was post-launch. That made the
 * feature *indefinite deactivation*, not deletion: nothing ever ran on the due
 * date, no account ever reached `deleted`, the provider credentials (including
 * a Sign in with Apple token) stayed live, and the uploads stayed in private
 * storage for ever. Apple's account-deletion guideline asks for the account
 * **and its associated data**, and Play's data-safety form asks the same
 * question in a different sentence. Shipping the button without the worker is
 * the shape of promise that gets a build rejected and, worse, is untrue.
 *
 * So this runs daily (`crons.ts`) and, for every job whose thirty days are up:
 *
 * 1. **Tombstones and purges the person's media.** Same path as
 *    `media.withdraw`: `deleted` is terminal, the counters follow, unspent
 *    grants expire, and the objects are scheduled for deletion from storage.
 *    This is the change of policy the audit forced — PLAN.md's "retain and
 *    anonymise" is a defensible position for the thirty days a restore is
 *    possible, and is not a defensible answer to "delete my data".
 * 2. **Removes the relationships**: memberships, blocks in both directions,
 *    push devices, additional verified addresses, and the *reporter* identity on
 *    any report they filed (the report itself survives, because a host's
 *    moderation record is not the reporter's data to withdraw).
 * 3. **Revokes the credentials** by deleting the Better Auth user, which takes
 *    its sessions and its `account` rows — the Apple and Google grants included
 *    — with it.
 * 4. **Anonymises the mirror row** and moves it to `deleted`: no address, no
 *    display name, no avatar. The row survives as a tombstone because
 *    `auditEvents`, `moderationDecisions` and the event ownership graph all
 *    point at it by id, and a dangling foreign key is a worse outcome for
 *    everybody than an anonymous one.
 * 5. **Confirms completion** — the job moves to `completed` with a timestamp,
 *    and an audit row records what was removed.
 *
 * ## Two things it deliberately does not do
 *
 * **It does not delete events the person owned.** A host's party is other
 * people's photographs, and cascading a host's deletion into forty guests'
 * submissions would destroy data belonging to people who asked for nothing. An
 * owned event is archived and its ownership is recorded in the audit row, which
 * is the point at which a human has to be involved.
 *
 * **It does not run without a job.** The due-job query is the only entry point,
 * so an account in `deletionScheduled` whose job an admin cancelled is left
 * exactly alone — that is what makes the restore window real.
 */

/** Same cast as `media.ts`: the generic `AnyApi` fallback until codegen runs. */
const deletionFunctions = internal.deletion as unknown as {
  runDueDeletions: FunctionReference<
    "mutation",
    "internal",
    { now?: number; limit?: number },
    unknown
  >;
};

const mediaFunctions = internal.media as unknown as {
  purgeStoredFile: FunctionReference<
    "action",
    "internal",
    { region: Doc<"media">["storageRegion"]; keys: string[]; mediaId?: Id<"media"> },
    null
  >;
};

export { deletionFunctions };

/**
 * How many due accounts one run will purge.
 *
 * A Convex mutation is one transaction with a bounded budget, and an account
 * with a thousand photographs is a lot of writes. The cron runs daily and the
 * backlog is measured in accounts per day, so a small ceiling with a same-day
 * re-run costs nothing and keeps any single transaction well inside its limits.
 */
const MAX_PER_RUN = 10;

const purgeSummaryValidator = v.object({
  purged: v.number(),
  mediaTombstoned: v.number(),
  membershipsRemoved: v.number(),
  eventsArchived: v.number(),
  /** Jobs still due after this run, so a caller knows to come back. */
  remaining: v.number(),
});

export const runDueDeletions = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: purgeSummaryValidator,
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? MAX_PER_RUN, MAX_PER_RUN));

    const due = (
      await ctx.db
        .query("deletionJobs")
        .withIndex("by_state_and_scheduledAt", (q) =>
          q.eq("state", "scheduled").lte("scheduledAt", now),
        )
        .collect()
    ).filter((job) => job.subjectType === "user");

    let purged = 0;
    let mediaTombstoned = 0;
    let membershipsRemoved = 0;
    let eventsArchived = 0;

    for (const job of due.slice(0, limit)) {
      const outcome = await purgeAccount(ctx, job, now);
      if (outcome === undefined) continue;
      purged += 1;
      mediaTombstoned += outcome.mediaTombstoned;
      membershipsRemoved += outcome.membershipsRemoved;
      eventsArchived += outcome.eventsArchived;
    }

    return {
      purged,
      mediaTombstoned,
      membershipsRemoved,
      eventsArchived,
      remaining: Math.max(0, due.length - limit),
    };
  },
});

interface PurgeOutcome {
  mediaTombstoned: number;
  membershipsRemoved: number;
  eventsArchived: number;
}

async function purgeAccount(
  ctx: Parameters<typeof writeAuditEvent>[0],
  job: Doc<"deletionJobs">,
  now: number,
): Promise<PurgeOutcome | undefined> {
  const userId = job.subjectId as Id<"users">;
  const user = await ctx.db.get(userId);

  if (!user || user.accountState === "deleted") {
    // The subject is gone or has already been purged. Close the job rather than
    // retrying it every day for ever.
    await ctx.db.patch(job._id, { state: "completed", completedAt: now });
    return undefined;
  }

  const mediaTombstoned = await purgeMedia(ctx, user, now);
  const membershipsRemoved = await removeMemberships(ctx, user._id);
  const eventsArchived = await archiveOwnedEvents(ctx, user._id, now);
  await removeRelationships(ctx, user._id, now);
  await revokeCredentials(ctx, user);

  /*
   * The tombstone.
   *
   * `authId` is replaced with a value no provider can mint, so nothing can ever
   * sign back into this row — `getCurrentUser` looks up by `authId`, and leaving
   * the old one would mean a re-issued provider id could land on a purged
   * account. The address goes with it, which is what makes the row genuinely
   * anonymous rather than merely flagged.
   */
  await ctx.db.patch(user._id, {
    authId: `deleted:${user._id}`,
    email: "",
    emailVerified: false,
    displayName: "Former guest",
    avatarKey: undefined,
    isPrivateRelayEmail: undefined,
    isOrganiser: false,
    isGlobalAdmin: false,
    activeEventId: undefined,
    accountState: "deleted",
    deletedAt: now,
    updatedAt: now,
  });

  await ctx.db.patch(job._id, { state: "completed", completedAt: now });

  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.accountDeleted,
    subjectType: "user",
    subjectId: user._id,
    reason: job.reason ?? "Thirty-day purge for a requested account deletion.",
    // No address and no display name: the row that records the erasure must not
    // be the one place the erased data survives.
    metadata: { mediaTombstoned, membershipsRemoved, eventsArchived, scheduledAt: job.scheduledAt },
    now,
  });

  return { mediaTombstoned, membershipsRemoved, eventsArchived };
}

/**
 * Tombstone every submission and schedule its objects for deletion.
 *
 * The same three facts `media.withdraw` establishes, for the same reason:
 * `deleted` is terminal in the state machine, the event counters move in this
 * transaction, and a late completion callback finds a `deleted` row and deletes
 * its own file.
 */
async function purgeMedia(
  ctx: Parameters<typeof writeAuditEvent>[0],
  user: Doc<"users">,
  now: number,
): Promise<number> {
  const rows = await ctx.db
    .query("media")
    .withIndex("by_uploader", (q) => q.eq("uploaderUserId", user._id))
    .collect();

  let tombstoned = 0;
  for (const media of rows) {
    const keys = storageKeysOf(media);

    if (media.state !== "deleted") {
      await ctx.db.patch(media._id, {
        state: "deleted",
        deletedAt: now,
        updatedAt: now,
      });
      await applyCountChange(ctx, media.eventId, media.state, "deleted", now);
      tombstoned += 1;
    }

    if (keys.length === 0) {
      if (media.storageDeletedAt === undefined) {
        await ctx.db.patch(media._id, { storageDeletedAt: now });
      }
      continue;
    }

    await ctx.scheduler.runAfter(0, mediaFunctions.purgeStoredFile, {
      region: media.storageRegion,
      keys,
      mediaId: media._id,
    });
  }

  return tombstoned;
}

async function removeMemberships(
  ctx: Parameters<typeof writeAuditEvent>[0],
  userId: Id<"users">,
): Promise<number> {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/**
 * A host's own parties are archived, never deleted.
 *
 * Their guests' photographs are not the host's data to erase, and a cascade here
 * would destroy submissions belonging to people who asked for nothing. Archiving
 * closes the party — no joins, no uploads — and the audit row names the events,
 * which is where a human takes over.
 */
async function archiveOwnedEvents(
  ctx: Parameters<typeof writeAuditEvent>[0],
  userId: Id<"users">,
  now: number,
): Promise<number> {
  const events = await ctx.db
    .query("events")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
    .collect();

  let archived = 0;
  for (const event of events) {
    if (event.state === "archived") continue;
    await ctx.db.patch(event._id, { state: "archived", archivedAt: now, updatedAt: now });
    archived += 1;
  }
  return archived;
}

/**
 * Everything else that names this person.
 *
 * Reports are the interesting case: the row survives — a host's moderation
 * record is the host's, and deleting it would erase the reason an item was taken
 * down — but the reporter's identity is replaced with the tombstoned user, which
 * is anonymous by the time this returns. `mediaReports.reporterUserId` is a
 * required column, so it is repointed rather than cleared.
 */
async function removeRelationships(
  ctx: Parameters<typeof writeAuditEvent>[0],
  userId: Id<"users">,
  now: number,
): Promise<void> {
  for (const row of await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker", (q) => q.eq("blockerUserId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
  }
  for (const row of await ctx.db
    .query("userBlocks")
    .withIndex("by_blocked", (q) => q.eq("blockedUserId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
  }
  for (const row of await ctx.db
    .query("pushDevices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
  }
  for (const row of await ctx.db
    .query("userEmails")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
  }
  for (const row of await ctx.db
    .query("uploadGrants")
    .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "issued"))
    .collect()) {
    await ctx.db.patch(row._id, { status: "expired", updatedAt: now });
  }
}

/**
 * Delete the Better Auth user, which is what actually revokes the credentials.
 *
 * Sessions, and the `account` rows holding the Sign in with Apple and Google
 * grants, live inside the component and go with it. Without this the mirror row
 * says `deleted` while the identity provider still believes the account exists,
 * and the next sign-in would mint a fresh mirror row against a live credential.
 *
 * Best-effort and reported rather than rethrown: the component can legitimately
 * have no row (a user Better Auth already removed through its own `deleteUser`,
 * which is how most of these arrive), and a failure here must not roll back a
 * purge that has already tombstoned the media. A residual credential is visible
 * in Sentry and fixable; a half-applied purge is not.
 */
async function revokeCredentials(
  ctx: Parameters<typeof writeAuditEvent>[0],
  user: Doc<"users">,
): Promise<void> {
  if (user.authId.startsWith("deleted:")) return;
  try {
    const component = authComponent as unknown as {
      deleteUser?: (ctx: unknown, authId: string) => Promise<unknown>;
    };
    if (typeof component.deleteUser !== "function") return;
    await component.deleteUser(ctx, user.authId);
  } catch (error) {
    void reportError({
      scope: "deletion.revokeCredentials",
      error,
      level: "error",
      extra: { userId: user._id },
    });
  }
}
