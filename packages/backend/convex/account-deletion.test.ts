import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./testing.helpers";
import { ACCOUNT_DELETION_GRACE_MS, scheduleAccountDeletion } from "./lib/account-deletion";
import schema from "./schema";

type T = TestConvex<SchemaDefinition<typeof schema.tables, true>>;

const modules = import.meta.glob("./**/*.*s");

const NOW = 1_800_000_000_000;

describe("scheduleAccountDeletion", () => {
  let t: T;
  let userId: Id<"users">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: "auth_1",
        email: "guest@partybooth.test",
        emailVerified: true,
        displayName: "Guest",
        accountState: "active",
        isOrganiser: false,
        isGlobalAdmin: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  });

  const run = (options: Parameters<typeof scheduleAccountDeletion>[2] = {}) =>
    t.run(async (ctx) => {
      const user = (await ctx.db.get(userId)) as Doc<"users">;
      return await scheduleAccountDeletion(ctx, user, { now: NOW, ...options });
    });

  const user = () => t.run(async (ctx) => ctx.db.get(userId));
  const jobs = () => t.run(async (ctx) => ctx.db.query("deletionJobs").collect());
  const audits = () => t.run(async (ctx) => ctx.db.query("auditEvents").collect());

  it("moves the account to deletionScheduled, never straight to deleted", async () => {
    await run();
    const after = await user();
    // `deleted` is the purge worker's state (P1). Using it here would make the
    // restore window unreachable: `deleted` is terminal in the state machine.
    expect(after?.accountState).toBe("deletionScheduled");
    expect(after?.deletionScheduledAt).toBe(NOW);
    expect(after?.deletedAt).toBeUndefined();
  });

  it("records the intent as a scheduled deletionJobs row, due in thirty days", async () => {
    const result = await run();
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectType: "user",
      subjectId: userId,
      state: "scheduled",
      scheduledAt: NOW + ACCOUNT_DELETION_GRACE_MS,
    });
    expect(result.scheduledAt).toBe(NOW + ACCOUNT_DELETION_GRACE_MS);
  });

  it("writes an audit row with a reason, which the action requires", async () => {
    await run();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe(AUDIT_ACTIONS.accountDeletionScheduled);
    expect(rows[0]?.subjectId).toBe(userId);
    expect(rows[0]?.reason).toBeTruthy();
  });

  it("carries the admin's reason and actor when one is supplied", async () => {
    await run({ requestedByUserId: userId, reason: "Abuse report #12" });
    const rows = await audits();
    expect(rows[0]?.reason).toBe("Abuse report #12");
    expect(rows[0]?.actorUserId).toBe(userId);
    expect((await jobs())[0]?.reason).toBe("Abuse report #12");
  });

  it("is idempotent — two requests do not create two jobs", async () => {
    await run();
    await run({ now: NOW + 1000 });
    expect(await jobs()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it("does nothing for an already-purged account", async () => {
    await t.run(async (ctx) => ctx.db.patch(userId, { accountState: "deleted", deletedAt: NOW }));
    const result = await run();
    expect(result.jobId).toBeUndefined();
    expect(await jobs()).toHaveLength(0);
    expect((await user())?.accountState).toBe("deleted");
  });
});

/* -------------------------------------------------------------------------- */
/* The purge worker                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What "delete my account" has to actually mean.
 *
 * Scheduling on its own is deactivation. These pin the second half: on the due
 * date the media is tombstoned and its objects are scheduled for deletion, the
 * relationships go, the mirror row is anonymised and reaches `deleted`, and the
 * job is closed — so the thirty-day promise is something the deployment keeps
 * rather than something the copy claims.
 */
describe("deletion.runDueDeletions", () => {
  let t: T;
  let userId: Id<"users">;
  let hostId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    hostId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: "auth_host",
        email: "host@partybooth.test",
        emailVerified: true,
        displayName: "Host",
        accountState: "active",
        isOrganiser: true,
        isGlobalAdmin: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: "auth_guest",
        email: "guest@partybooth.test",
        emailVerified: true,
        displayName: "Guest",
        accountState: "active",
        isOrganiser: false,
        isGlobalAdmin: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    eventId = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        ownerUserId: hostId,
        name: "Party",
        state: "live",
        moderationMode: "manual",
        storageRegion: "pdx1",
        startsAt: NOW,
        timeZone: "Europe/London",
        allowLibraryImport: true,
        counts: { pending: 0, approved: 1, declined: 0, total: 1 },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        eventId,
        userId,
        role: "guest",
        status: "active",
        joinedAt: NOW,
      });
      await ctx.db.insert("media", {
        eventId,
        uploaderUserId: userId,
        captureId: "capture-1",
        state: "approved",
        mediaType: "photo",
        storageKey: "ut_guest_0001",
        previewKey: "ut_guest_preview",
        storageRegion: "pdx1",
        byteSize: 2048,
        mimeType: "image/jpeg",
        checksum: "a".repeat(64),
        fromLibrary: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("pushDevices", {
        userId,
        expoPushToken: "ExponentPushToken[abc]",
        platform: "ios",
        failureCount: 0,
        lastSeenAt: NOW,
        createdAt: NOW,
      });
    });
  });

  const schedule = () =>
    t.run(async (ctx) => {
      const user = (await ctx.db.get(userId)) as Doc<"users">;
      return await scheduleAccountDeletion(ctx, user, { now: NOW });
    });

  it("does nothing until the thirty days are up", async () => {
    await schedule();
    const summary = await t.mutation(internal.deletion.runDueDeletions, { now: NOW + 1000 });
    expect(summary.purged).toBe(0);
    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user?.accountState).toBe("deletionScheduled");
  });

  it("erases the account and its media once they are", async () => {
    await schedule();
    const summary = await t.mutation(internal.deletion.runDueDeletions, {
      now: NOW + ACCOUNT_DELETION_GRACE_MS + 1,
    });

    expect(summary).toMatchObject({ purged: 1, mediaTombstoned: 1 });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user?.accountState).toBe("deleted");
    // Anonymous, not merely flagged: the row survives because audit rows and
    // moderation decisions point at it, and a dangling id is worse for everybody.
    expect(user?.email).toBe("");
    expect(user?.displayName).toBe("Former guest");
    // And nothing can ever sign back into it.
    expect(user?.authId).not.toBe("auth_guest");

    const media = await t.run(async (ctx) => ctx.db.query("media").collect());
    expect(media[0]?.state).toBe("deleted");

    const [memberships, devices] = await t.run(async (ctx) => [
      await ctx.db.query("memberships").collect(),
      await ctx.db.query("pushDevices").collect(),
    ]);
    expect(memberships).toHaveLength(0);
    expect(devices).toHaveLength(0);

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.counts.approved).toBe(0);

    const jobs = await t.run(async (ctx) => ctx.db.query("deletionJobs").collect());
    expect(jobs[0]?.state).toBe("completed");
    expect(jobs[0]?.completedAt).toBeGreaterThan(0);
  });

  it("archives a host's own parties rather than deleting other people's photographs", async () => {
    await t.run(async (ctx) => {
      const host = (await ctx.db.get(hostId)) as Doc<"users">;
      await scheduleAccountDeletion(ctx, host, { now: NOW });
    });
    await t.mutation(internal.deletion.runDueDeletions, {
      now: NOW + ACCOUNT_DELETION_GRACE_MS + 1,
    });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.state).toBe("archived");
    // The guest's photograph is not the host's to erase.
    const media = await t.run(async (ctx) => ctx.db.query("media").collect());
    expect(media[0]?.state).toBe("approved");
  });

  it("leaves a cancelled job's account exactly alone — the restore window is real", async () => {
    await schedule();
    await t.run(async (ctx) => {
      const [job] = await ctx.db.query("deletionJobs").collect();
      if (job) await ctx.db.patch(job._id, { state: "cancelled", cancelledAt: NOW });
    });

    const summary = await t.mutation(internal.deletion.runDueDeletions, {
      now: NOW + ACCOUNT_DELETION_GRACE_MS + 1,
    });
    expect(summary.purged).toBe(0);
    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user?.accountState).toBe("deletionScheduled");
  });
});
