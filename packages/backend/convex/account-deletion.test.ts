import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
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
