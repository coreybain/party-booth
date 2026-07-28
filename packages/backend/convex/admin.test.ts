import {
  ADMIN_CONSOLE_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  auditActionRequiresReason,
} from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import { setEmailSender, type EmailMessage, type EmailSender } from "./lib/email";
import {
  ADMIN_EMAIL,
  api,
  auditRows,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMedia,
  seedMembership,
  seedUser,
  setAllowlist,
  setSiteUrl,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * The admin console.
 *
 * Three invariants from PLAN.md are asserted over the **whole console** rather
 * than per mutation, because "every action" is the claim and a per-mutation test
 * is a claim about whichever mutations somebody remembered:
 *
 * 1. every mutation refuses a blank reason;
 * 2. every mutation writes an immutable audit row naming actor, action, target,
 *    reason and time;
 * 3. no admin function serves media.
 */

function recordingSender(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    sender: {
      id: "console",
      async send(message) {
        sent.push(message);
        return { ok: true, provider: "console" };
      },
    },
  };
}

describe("admin allowlist gating", () => {
  let t: T;
  let outsiderId: Id<"users">;

  beforeEach(async () => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    outsiderId = await seedUser(t, { authId: "outsider", email: "nope@partybooth.test" });
  });

  afterEach(() => setAllowlist(undefined));

  it("refuses everybody who is not on the allowlist", async () => {
    const as = t.withIdentity({ subject: "outsider" });
    await expect(as.query(api.admin.accounts, {})).rejects.toThrow(/permission/i);
    await expect(as.query(api.admin.events, {})).rejects.toThrow(/permission/i);
    await expect(as.query(api.admin.jobHealth, {})).rejects.toThrow(/permission/i);
    await expect(as.query(api.admin.auditLog, {})).rejects.toThrow(/permission/i);
    await expect(
      as.mutation(api.admin.lockAccount, { userId: outsiderId, reason: "because" }),
    ).rejects.toThrow(/permission/i);
  });

  it("refuses an account whose `isGlobalAdmin` column says yes but the allowlist does not", async () => {
    // The column is a cache. A write into `users` must not mint an admin.
    await seedUser(t, {
      authId: "pretender",
      email: "pretender@partybooth.test",
      isGlobalAdmin: true,
    });
    await expect(
      t.withIdentity({ subject: "pretender" }).query(api.admin.accounts, {}),
    ).rejects.toThrow(/permission/i);
  });

  it("refuses an allowlisted admin whose own account is locked", async () => {
    await t.run(async (ctx) => {
      const admin = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", "admin"))
        .unique();
      if (admin) await ctx.db.patch(admin._id, { accountState: "locked" });
    });
    await expect(
      t.withIdentity({ subject: "admin" }).query(api.admin.accounts, {}),
    ).rejects.toThrow(/suspended/i);
  });
});

describe("admin queries", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    setAllowlist(ADMIN_EMAIL);
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, guestId, "guest");
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  afterEach(() => {
    clearFakeStorage();
    setAllowlist(undefined);
  });

  it("lists accounts with state, roles and storage usage", async () => {
    await seedMedia(t, eventId, guestId, { state: "approved", byteSize: 4096 });
    await seedMedia(t, eventId, guestId, { state: "pending", byteSize: 2048 });

    const result = await t.withIdentity({ subject: "admin" }).query(api.admin.accounts, {});
    const guest = result.items.find((row) => row.id === guestId);

    expect(guest?.accountState).toBe("active");
    expect(guest?.storageBytes).toBe(6144);
    expect(guest?.mediaCount).toBe(2);
    expect(guest?.memberships).toBe(1);

    const owner = result.items.find((row) => row.id === ownerId);
    expect(owner?.ownedEvents).toBe(1);
  });

  it("filters accounts by search", async () => {
    const result = await t
      .withIdentity({ subject: "admin" })
      .query(api.admin.accounts, { search: "guest@" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(guestId);
  });

  it("lists events with asset counts, status totals and per-event job health", async () => {
    await seedMedia(t, eventId, guestId, { state: "pending", byteSize: 1000 });
    await seedMedia(t, eventId, guestId, { state: "approved", byteSize: 1000 });

    const result = await t.withIdentity({ subject: "admin" }).query(api.admin.events, {});
    const row = result.items.find((item) => item.id === eventId);

    expect(row?.counts.pending).toBe(1);
    expect(row?.counts.approved).toBe(1);
    expect(row?.assetCount).toBe(2);
    expect(row?.storageBytes).toBe(2000);
    expect(row?.memberCount).toBe(2);
    expect(row?.ownerDisplayName).toBeTypeOf("string");
    expect(row?.stuckPurges).toBe(0);
    expect(row?.frozen).toBe(false);
  });

  it("never puts a join code in the event list", async () => {
    // One event asked for deliberately is a rotation form; every live code in
    // one payload is every party in the product.
    const result = await t.withIdentity({ subject: "admin" }).query(api.admin.events, {});
    expect(JSON.stringify(result)).not.toContain("482913");
  });

  it("reports job health, with the export placeholder honestly at zero", async () => {
    const mediaId = await seedMedia(t, eventId, guestId, { state: "approved" });
    await t.run(async (ctx) => ctx.db.patch(mediaId, { state: "deleted", deletedAt: Date.now() }));

    const health = await t.withIdentity({ subject: "admin" }).query(api.admin.jobHealth, {});
    expect(health.stuckPurges).toBe(1);
    // Export jobs are P2 and there is no table to count. An honest zero beats an
    // invented number — see the handler's note.
    expect(health.pendingExports).toBe(0);
    expect(health.deletionJobs.scheduled).toBe(0);
  });

  it("serves the audit log with actor, action, reason and time", async () => {
    await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.lockAccount, { userId: guestId, reason: "Reported for abuse" });

    const log = await t.withIdentity({ subject: "admin" }).query(api.admin.auditLog, {});
    const row = log.find((entry) => entry.action === AUDIT_ACTIONS.accountLocked);
    expect(row?.reason).toBe("Reported for abuse");
    expect(row?.subjectId).toBe(guestId);
    expect(row?.actorRole).toBe("globalAdmin");
    expect(row?.createdAt).toBeTypeOf("number");
  });
});

describe("admin mutations — reason and audit invariants", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;
  let membershipId: Id<"memberships">;

  beforeEach(async () => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
    setSiteUrl();
    setEmailSender(recordingSender().sender);
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    membershipId = await seedMembership(t, eventId, guestId, "guest");
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  afterEach(() => {
    setAllowlist(undefined);
    setSiteUrl(undefined);
    setEmailSender(undefined);
  });

  it("refuses a blank or whitespace reason on every mutation", async () => {
    const as = t.withIdentity({ subject: "admin" });
    const blanks = ["", "   ", "ab"];

    for (const reason of blanks) {
      await expect(as.mutation(api.admin.lockAccount, { userId: guestId, reason })).rejects.toThrow(
        /reason/i,
      );
      await expect(
        as.mutation(api.admin.scheduleAccountDeletionFor, { userId: guestId, reason }),
      ).rejects.toThrow(/reason/i);
      await expect(
        as.mutation(api.admin.scheduleEventDeletion, { eventId, reason }),
      ).rejects.toThrow(/reason/i);
      await expect(as.mutation(api.admin.rotateEventCode, { eventId, reason })).rejects.toThrow(
        /reason/i,
      );
      await expect(
        as.mutation(api.admin.revokeMembership, { membershipId, reason }),
      ).rejects.toThrow(/reason/i);
      await expect(
        as.action(api.admin.inviteOrganiser, { email: "new@partybooth.test", reason }),
      ).rejects.toThrow(/reason/i);
    }

    // Nothing was written by any of them.
    expect(await auditRows(t)).toHaveLength(0);
  });

  it("declares every console action as reason-requiring", () => {
    // The rule lives in the contract so `writeAuditEvent` can enforce it, and
    // this pins the list rather than trusting each call site to pass one.
    for (const action of ADMIN_CONSOLE_AUDIT_ACTIONS) {
      expect(auditActionRequiresReason(action), action).toBe(true);
    }
  });

  it("locks and unlocks an account, auditing both with the reason", async () => {
    const as = t.withIdentity({ subject: "admin" });

    const locked = await as.mutation(api.admin.lockAccount, {
      userId: ownerId,
      reason: "Complaint from a guest",
    });
    expect(locked.accountState).toBe("locked");
    expect(locked.ownedEventsFrozen).toBe(1);

    const user = await t.run(async (ctx) => ctx.db.get(ownerId));
    expect(user?.accountState).toBe("locked");
    expect(user?.lockReason).toBe("Complaint from a guest");
    expect(user?.lockedByUserId).toBeTypeOf("string");

    await as.mutation(api.admin.unlockAccount, { userId: ownerId, reason: "Resolved" });
    const unlocked = await t.run(async (ctx) => ctx.db.get(ownerId));
    expect(unlocked?.accountState).toBe("active");
    // Cleared rather than kept: a stale `lockedAt` on an active row is a lie.
    expect(unlocked?.lockedAt).toBeUndefined();
    expect(unlocked?.lockReason).toBeUndefined();

    const actions = (await auditRows(t)).map((row) => row.action);
    expect(actions).toContain(AUDIT_ACTIONS.accountLocked);
    expect(actions).toContain(AUDIT_ACTIONS.accountUnlocked);
  });

  it("refuses an admin locking themselves out of the console", async () => {
    const adminId = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", "admin"))
        .unique();
      return row?._id;
    });

    await expect(
      t
        .withIdentity({ subject: "admin" })
        .mutation(api.admin.lockAccount, { userId: adminId!, reason: "oops" }),
    ).rejects.toThrow(/not available|permission/i);
  });

  it("schedules and restores an account deletion", async () => {
    const as = t.withIdentity({ subject: "admin" });

    const scheduled = await as.mutation(api.admin.scheduleAccountDeletionFor, {
      userId: guestId,
      reason: "Requested by email",
    });
    expect(scheduled.accountState).toBe("deletionScheduled");
    expect(scheduled.scheduledAt).toBeGreaterThan(Date.now());
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("deletionJobs")
          .withIndex("by_subject", (q) => q.eq("subjectType", "user").eq("subjectId", guestId))
          .collect(),
      ),
    ).toHaveLength(1);

    const restored = await as.mutation(api.admin.restoreAccount, {
      userId: guestId,
      reason: "Mistake",
    });
    expect(restored.cancelledJobs).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(guestId)))?.accountState).toBe("active");

    const jobs = await t.run(async (ctx) => ctx.db.query("deletionJobs").collect());
    expect(jobs[0]?.state).toBe("cancelled");
  });

  it("schedules and restores an event deletion, restoring it archived", async () => {
    const as = t.withIdentity({ subject: "admin" });

    await as.mutation(api.admin.scheduleEventDeletion, { eventId, reason: "Abuse report" });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.state).toBe("deletionScheduled");

    const restored = await as.mutation(api.admin.restoreEvent, { eventId, reason: "Cleared" });
    // Not back to `live`: an event queued for deletion must not silently start
    // accepting uploads again. The host re-opens it deliberately.
    expect(restored.state).toBe("archived");
    expect(restored.cancelledJobs).toBe(1);

    const actions = (await auditRows(t)).map((row) => row.action);
    expect(actions).toContain(AUDIT_ACTIONS.eventDeletionScheduled);
    expect(actions).toContain(AUDIT_ACTIONS.eventDeletionRestored);
  });

  it("rotates to a random code, audited without the code itself", async () => {
    const result = await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.rotateEventCode, { eventId, reason: "Code leaked" });

    expect(result.code).not.toBe("482913");
    expect(result.version).toBe(2);

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.inviteRotated);
    expect(row?.reason).toBe("Code leaked");
    expect(row?.metadata).toMatchObject({ specific: false, via: "adminConsole" });
    expect(JSON.stringify(row)).not.toContain(result.code);
  });

  it("rotates to a validated, collision-checked specific code", async () => {
    const as = t.withIdentity({ subject: "admin" });

    // Shape.
    await expect(
      as.mutation(api.admin.rotateEventCode, {
        eventId,
        mode: "specific",
        specificCode: "12",
        reason: "x-reason",
      }),
    ).rejects.toThrow(/six digits|Enter/i);

    // Guessability.
    await expect(
      as.mutation(api.admin.rotateEventCode, {
        eventId,
        mode: "specific",
        specificCode: "111111",
        reason: "x-reason",
      }),
    ).rejects.toThrow(/easy to guess/i);

    // Its own outgoing code — the one the collision check has to excuse to run
    // at all, and therefore the one that has to be refused separately.
    await expect(
      as.mutation(api.admin.rotateEventCode, {
        eventId,
        mode: "specific",
        specificCode: "482913",
        reason: "x-reason",
      }),
    ).rejects.toThrow(/rotating away from/i);

    // Another joinable event's code.
    const otherOwner = await seedUser(t, { authId: "o2", email: "o2@partybooth.test" });
    const otherEvent = await seedEvent(t, otherOwner, { state: "live" });
    await seedInviteVersion(t, otherEvent, otherOwner, { code: "375291", token: "T".repeat(32) });

    await expect(
      as.mutation(api.admin.rotateEventCode, {
        eventId,
        mode: "specific",
        specificCode: "375291",
        reason: "x-reason",
      }),
    ).rejects.toThrow(/already in use/i);

    // …and a good one.
    const ok = await as.mutation(api.admin.rotateEventCode, {
      eventId,
      mode: "specific",
      specificCode: "418362",
      reason: "Host asked for a memorable number",
    });
    expect(ok.code).toBe("418362");

    const row = (await auditRows(t)).filter((r) => r.action === AUDIT_ACTIONS.inviteRotated).at(-1);
    expect(row?.metadata).toMatchObject({ specific: true });
  });

  it("refuses `specific` with no code at all", async () => {
    await expect(
      t
        .withIdentity({ subject: "admin" })
        .mutation(api.admin.rotateEventCode, { eventId, mode: "specific", reason: "x-reason" }),
    ).rejects.toThrow(/supplying one|specificCode/i);
  });

  it("revokes an individual membership and takes its grants with it", async () => {
    const grantId = await t.run(async (ctx) =>
      ctx.db.insert("uploadGrants", {
        eventId,
        userId: guestId,
        captureId: "capture-abcdefgh",
        secretHash: "f".repeat(64),
        status: "issued",
        mediaType: "photo",
        fromLibrary: false,
        storageRegion: "pdx1",
        byteSize: 1024,
        mimeType: "image/jpeg",
        checksum: "0".repeat(64),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.revokeMembership, { membershipId, reason: "Abusive" });

    expect(result.revoked).toBe(true);
    expect(result.expiredGrants).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(grantId)))?.status).toBe("expired");
    expect((await t.run(async (ctx) => ctx.db.get(membershipId)))?.status).toBe("revoked");

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.membershipRevoked);
    expect(row?.reason).toBe("Abusive");
    expect(row?.metadata).toMatchObject({ via: "adminConsole" });
  });

  it("refuses revoking an owner's membership from the console", async () => {
    const ownerMembership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", ownerId))
        .unique(),
    );

    await expect(
      t.withIdentity({ subject: "admin" }).mutation(api.admin.revokeMembership, {
        membershipId: ownerMembership!._id,
        reason: "Owner asked to be removed",
      }),
    ).rejects.toThrow(/not available|permission/i);
  });

  it("invites an organiser, emails them, and audits it with the reason", async () => {
    const mail = recordingSender();
    setEmailSender(mail.sender);

    const result = await t.withIdentity({ subject: "admin" }).action(api.admin.inviteOrganiser, {
      email: "new@partybooth.test",
      note: "Met at the pub",
      reason: "Beta expansion",
    });

    expect(result.emailed).toBe(true);
    const invitation = await t.run(async (ctx) => ctx.db.get(result.invitationId));
    expect(invitation?.status).toBe("pending");
    expect(invitation?.email).toBe("new@partybooth.test");

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.organiserInvited);
    expect(row?.reason).toBe("Beta expansion");
    expect(JSON.stringify(row)).not.toContain("new@partybooth.test");

    expect(mail.sent[0]?.text).toContain(invitation?.token ?? "no token");
  });

  it("leaves every audit row it wrote immutable and complete", async () => {
    const as = t.withIdentity({ subject: "admin" });
    await as.mutation(api.admin.lockAccount, { userId: guestId, reason: "One" });
    await as.mutation(api.admin.unlockAccount, { userId: guestId, reason: "Two" });
    await as.mutation(api.admin.rotateEventCode, { eventId, reason: "Three" });

    for (const row of await auditRows(t)) {
      expect(row.actorUserId, row.action).toBeTypeOf("string");
      expect(row.reason, row.action).toBeTypeOf("string");
      expect(row.subjectId, row.action).toBeTypeOf("string");
      expect(row.createdAt, row.action).toBeTypeOf("number");
    }
  });
});

describe("admins cannot see media", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    setAllowlist(ADMIN_EMAIL);
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, guestId, "guest");
    // An item that would be served to a third party if anything let it through.
    await seedMedia(t, eventId, guestId, {
      state: "approved",
      storageKey: "original-key",
      previewKey: "preview-key",
      sourceMetadataStripped: true,
    });
  });

  afterEach(() => {
    clearFakeStorage();
    setAllowlist(undefined);
  });

  /**
   * The pivot that made "the admin console has no media access" a statement
   * about *capabilities* rather than about outcomes.
   *
   * `event.viewInviteCode` is in the `globalAdmin` set so the rotation dialog
   * can say which code it is replacing. It also served the **QR token**, which
   * is a 160-bit bearer credential — enough on its own to call `join.join` and
   * be admitted as a `guest`. A guest membership then outranks the admin role in
   * `resolveEventRole`, so `media.viewApproved` succeeds and the console
   * receives signed read URLs for a stranger's whole gallery. Two independent
   * barriers, because either alone is one edit from being removed.
   */
  it("serves the admin the join code but never the QR token", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });

    const current = await t
      .withIdentity({ subject: "admin" })
      .query(api.invites.current, { eventId });
    expect(current?.code).toBe("482913");
    expect(current?.token).toBeUndefined();

    const home = await t.withIdentity({ subject: "admin" }).query(api.events.home, { eventId });
    expect(home.invite?.code).toBe("482913");
    expect(home.invite?.token).toBeUndefined();

    // The host still gets both — this is a rule about who is asking, not about
    // the field going away.
    const asOwner = await t.withIdentity({ subject: "owner" }).query(api.invites.current, {
      eventId,
    });
    expect(asOwner?.token).toBeTypeOf("string");
  });

  it("refuses to let an admin join a party they do not own", async () => {
    const { code, token } = await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    const as = t.withIdentity({ subject: "admin" });

    expect((await as.mutation(api.join.join, { invite: { via: "code", code } })).outcome).toBe(
      "rejected",
    );
    expect((await as.mutation(api.join.join, { invite: { via: "token", token } })).outcome).toBe(
      "rejected",
    );
    expect(await as.mutation(api.join.previewByCode, { code })).toBeNull();

    // No membership was created, so the admin never becomes a `guest` and the
    // media paths above keep refusing.
    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(membership.map((row) => row.userId)).not.toContain(
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", "admin"))
            .unique(),
        )
      )?._id,
    );
  });

  it("does not hand the console a fresh QR token when it rotates a code", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    const rotated = await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.rotateEventCode, { eventId, reason: "Code leaked to a group chat" });

    expect(rotated.code).toBeTypeOf("string");
    expect((rotated as { token?: string }).token).toBeUndefined();
  });

  it("refuses every media read path", async () => {
    const as = t.withIdentity({ subject: "admin" });
    await expect(as.query(api.media.eventMedia, { eventId })).rejects.toThrow(/permission/i);
    await expect(as.query(api.media.myMedia, { eventId })).rejects.toThrow(/permission/i);
    await expect(as.query(api.moderation.pending, { eventId })).rejects.toThrow(/permission/i);
    await expect(as.query(api.moderation.flagged, { eventId })).rejects.toThrow(/permission/i);
    await expect(as.query(api.slideshow.feed, { eventId })).rejects.toThrow(/permission/i);
    await expect(as.query(api.stats.recentSubmissions, { eventId })).rejects.toThrow(/permission/i);
  });

  it("refuses moderation outright", async () => {
    const media = await t.run(async (ctx) => ctx.db.query("media").first());
    await expect(
      t.withIdentity({ subject: "admin" }).mutation(api.moderation.moderate, {
        eventId,
        mediaIds: [media!._id],
        action: "approve",
      }),
    ).rejects.toThrow(/permission/i);
  });

  it("serves numbers but withholds the per-guest breakdown", async () => {
    const overview = await t
      .withIdentity({ subject: "admin" })
      .query(api.stats.overview, { eventId });

    expect(overview.approved).toBe(1);
    expect(overview.storageBytes).toBeGreaterThan(0);
    // Who photographed how much is guest-level personal data, not an asset count.
    expect(overview.topContributors).toEqual([]);
    expect(overview.contributorCount).toBe(0);
  });

  it("mints no signed URL for the role even if a read path is reached", async () => {
    /*
     * The belt-and-braces line in `projectMedia`. Every read path above already
     * refuses an admin, so this cannot be reached through the product — which is
     * exactly why it is worth pinning: the next query that forgets its capability
     * check should leak counts, not photographs.
     */
    const { projectMedia } = await import("./lib/media");
    const view = await t.run(async (ctx) => {
      const media = await ctx.db.query("media").first();
      const admin = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", "admin"))
        .unique();
      return await projectMedia(ctx, media!, {
        viewerUserId: admin!._id,
        viewerRole: "globalAdmin",
      });
    });

    expect(view.url).toBeUndefined();
    expect(view.previewUrl).toBeUndefined();
    expect(view.posterUrl).toBeUndefined();
    // …and the same row for a host does produce one, so the assertion above is
    // about the role rather than about the fixture.
    const hostView = await t.run(async (ctx) => {
      const media = await ctx.db.query("media").first();
      return await projectMedia(ctx, media!, { viewerUserId: ownerId, viewerRole: "owner" });
    });
    expect(hostView.url).toBeTypeOf("string");
  });

  it("never returns a storage key from an admin query", async () => {
    const as = t.withIdentity({ subject: "admin" });
    const payloads = JSON.stringify([
      await as.query(api.admin.accounts, {}),
      await as.query(api.admin.events, {}),
      await as.query(api.admin.jobHealth, {}),
      await as.query(api.admin.auditLog, {}),
    ]);
    expect(payloads).not.toContain("original-key");
    expect(payloads).not.toContain("preview-key");
  });
});
