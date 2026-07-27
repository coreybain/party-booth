import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  auditActionRequiresReason,
} from "@partybooth/contracts";
import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import { MissingAuditReasonError, writeAuditEvent, writeEventAudit } from "./lib/audit";
import schema from "./schema";

type T = TestConvex<SchemaDefinition<typeof schema.tables, true>>;

const modules = import.meta.glob("./**/*.*s");

const NOW = 1_800_000_000_000;

describe("writeAuditEvent", () => {
  let t: T;
  let actorId: Id<"users">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    actorId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: "auth_admin",
        email: "admin@partybooth.test",
        emailVerified: true,
        displayName: "Admin",
        accountState: "active",
        isOrganiser: false,
        isGlobalAdmin: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  });

  async function rows(): Promise<Doc<"auditEvents">[]> {
    return await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
  }

  it("writes an append-only row with actor, subject and timestamp", async () => {
    await t.run(async (ctx) =>
      writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.eventCreated,
        subjectType: "event",
        subjectId: "evt_123",
        actor: { userId: actorId, role: "owner" },
        now: NOW,
      }),
    );

    const [row] = await rows();
    expect(row).toMatchObject({
      action: "event.created",
      subjectType: "event",
      subjectId: "evt_123",
      actorUserId: actorId,
      actorRole: "owner",
      createdAt: NOW,
    });
  });

  it("omits absent fields rather than storing undefined", async () => {
    await t.run(async (ctx) =>
      writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.adminSignedIn,
        subjectType: "platform",
        now: NOW,
      }),
    );

    const [row] = await rows();
    expect(row).toBeDefined();
    expect(row && "subjectId" in row).toBe(false);
    expect(row && "actorUserId" in row).toBe(false);
    expect(row && "reason" in row).toBe(false);
  });

  it("refuses a destructive action with no reason", async () => {
    await expect(
      t.run(async (ctx) =>
        writeAuditEvent(ctx, {
          action: AUDIT_ACTIONS.accountLocked,
          subjectType: "user",
          subjectId: actorId,
          actor: { userId: actorId, role: "globalAdmin" },
          now: NOW,
        }),
      ),
    ).rejects.toThrow(MissingAuditReasonError);

    // …and writes nothing at all: a half-recorded lock is worse than none.
    expect(await rows()).toHaveLength(0);
  });

  it("treats a whitespace-only reason as no reason", async () => {
    await expect(
      t.run(async (ctx) =>
        writeAuditEvent(ctx, {
          action: AUDIT_ACTIONS.accountLocked,
          subjectType: "user",
          subjectId: actorId,
          reason: "   ",
          now: NOW,
        }),
      ),
    ).rejects.toThrow(MissingAuditReasonError);
  });

  it("stores a trimmed reason when one is given", async () => {
    await t.run(async (ctx) =>
      writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.accountLocked,
        subjectType: "user",
        subjectId: actorId,
        actor: { userId: actorId, role: "globalAdmin" },
        reason: "  Repeated abusive uploads  ",
        now: NOW,
      }),
    );

    const [row] = await rows();
    expect(row?.reason).toBe("Repeated abusive uploads");
  });

  it("keeps a metadata bag for the before/after detail", async () => {
    await t.run(async (ctx) =>
      writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.eventStateChanged,
        subjectType: "event",
        subjectId: "evt_1",
        metadata: { from: "live", to: "paused" },
        now: NOW,
      }),
    );

    const [row] = await rows();
    expect(row?.metadata).toEqual({ from: "live", to: "paused" });
  });

  it("appends rather than replacing", async () => {
    for (let i = 0; i < 3; i += 1) {
      await t.run(async (ctx) =>
        writeAuditEvent(ctx, {
          action: AUDIT_ACTIONS.joinRejected,
          subjectType: "event",
          subjectId: "evt_1",
          now: NOW + i,
        }),
      );
    }
    expect(await rows()).toHaveLength(3);
  });

  it("is queryable by every index the console needs", async () => {
    await t.run(async (ctx) =>
      writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.membershipRevoked,
        subjectType: "membership",
        subjectId: "mem_1",
        actor: { userId: actorId, role: "owner" },
        reason: "Left the party",
        now: NOW,
      }),
    );

    const byActor = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_actor", (q) => q.eq("actorUserId", actorId))
        .collect(),
    );
    const byAction = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_action", (q) => q.eq("action", AUDIT_ACTIONS.membershipRevoked))
        .collect(),
    );
    const bySubject = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_subject", (q) => q.eq("subjectType", "membership").eq("subjectId", "mem_1"))
        .collect(),
    );

    expect(byActor).toHaveLength(1);
    expect(byAction).toHaveLength(1);
    expect(bySubject).toHaveLength(1);
  });

  it("accepts every action the contract declares", async () => {
    for (const action of AUDIT_ACTION_NAMES) {
      await t.run(async (ctx) =>
        writeAuditEvent(ctx, {
          action,
          subjectType: "platform",
          ...(auditActionRequiresReason(action) ? { reason: "test" } : {}),
          now: NOW,
        }),
      );
    }
    expect(await rows()).toHaveLength(AUDIT_ACTION_NAMES.length);
  });
});

describe("writeEventAudit", () => {
  it("fills in the event id and subject for the per-event view", async () => {
    const t = convexTest(schema, modules);

    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: "auth_owner",
        email: "owner@partybooth.test",
        emailVerified: true,
        displayName: "Owner",
        accountState: "active",
        isOrganiser: true,
        isGlobalAdmin: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const eventId = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        ownerUserId: userId,
        name: "Party",
        state: "live",
        moderationMode: "manual",
        storageRegion: "pdx1",
        startsAt: NOW,
        timeZone: "Europe/London",
        allowLibraryImport: true,
        counts: { pending: 0, approved: 0, declined: 0, total: 0 },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );

    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      const user = await ctx.db.get(userId);
      return writeEventAudit(ctx, {
        action: AUDIT_ACTIONS.inviteRotated,
        event: event as Doc<"events">,
        actor: { user: user as Doc<"users">, role: "owner" },
        reason: "Poster went up outside",
        metadata: { version: 2 },
        now: NOW,
      });
    });

    const [row] = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );

    expect(row).toMatchObject({
      action: "event.invite_rotated",
      subjectType: "event",
      subjectId: eventId,
      eventId,
      actorUserId: userId,
      actorRole: "owner",
      reason: "Poster went up outside",
    });
  });
});
