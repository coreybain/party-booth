import { AUDIT_ACTIONS, ROTATION_POLICY } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  auditRows,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMembership,
  seedUser,
  setSiteUrl,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * Invite rotation, completed: keep-or-revoke, and the budget.
 *
 * Sprint 2 built the mutation and pinned the half that is about **credentials** —
 * the old code and token stop working. This suite is about the half that is
 * about **people**: `keepExistingMemberships: false` has to actually remove
 * them, leave a row per person in the append-only log, take away the capability
 * they were already holding, and let them back in only through the new code.
 */

describe("invites.rotate — keep versus revoke", () => {
  let t: T;
  let ownerId: Id<"users">;
  let cohostId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, cohostId, "cohost");
    await seedMembership(t, eventId, guestId, "guest");
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  afterEach(() => clearFakeStorage());

  it("keeps every membership by default", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.invites.rotate, { eventId });

    expect(result.revokedMemberships).toBe(0);
    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(memberships.every((m) => m.status === "active")).toBe(true);
  });

  it("revokes guests, keeps hosts, and writes one audit row per person removed", async () => {
    const secondGuest = await seedUser(t, { authId: "guest2", email: "g2@partybooth.test" });
    await seedMembership(t, eventId, secondGuest, "guest");

    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.invites.rotate, {
      eventId,
      keepExistingMemberships: false,
      reason: "Code was on a poster that walked off",
    });

    expect(result.revokedMemberships).toBe(2);

    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    const byUser = new Map(memberships.map((m) => [m.userId, m]));
    // Hosts keep their seats — locking the co-host out mid-party helps nobody.
    expect(byUser.get(ownerId)?.status).toBe("active");
    expect(byUser.get(cohostId)?.status).toBe("active");
    expect(byUser.get(guestId)?.status).toBe("revoked");
    expect(byUser.get(secondGuest)?.status).toBe("revoked");
    expect(byUser.get(guestId)?.revokeReason).toContain("poster");

    const revocations = (await auditRows(t)).filter(
      (row) => row.action === AUDIT_ACTIONS.membershipRevoked,
    );
    // One row per person, not one aggregate on the rotation.
    expect(revocations).toHaveLength(2);
    expect(revocations.every((row) => row.metadata?.["via"] === "inviteRotation")).toBe(true);
    expect(revocations.every((row) => typeof row.reason === "string")).toBe(true);
  });

  it("records the rotation itself with the keep/revoke choice and never the code", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await as.mutation(api.invites.rotate, { eventId, keepExistingMemberships: false });

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.inviteRotated);
    expect(row?.metadata).toMatchObject({
      keptMemberships: false,
      revokedMemberships: 1,
      specific: false,
      via: "hostConsole",
    });
    expect(row?.reason).toBeTypeOf("string");
    // The six digits are not an audit-log fact: these rows are read in bulk.
    expect(JSON.stringify(row)).not.toContain("482913");
  });

  it("takes the revoked guest's access away reactively", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const guest = t.withIdentity({ subject: "guest" });

    // Before: they are in.
    expect(await guest.query(api.events.home, { eventId })).toBeTruthy();

    await as.mutation(api.invites.rotate, { eventId, keepExistingMemberships: false });

    // After: the event simply is not theirs any more. `notFound`, not
    // `forbidden`, because that is what every non-member gets.
    await expect(guest.query(api.events.home, { eventId })).rejects.toThrow(/could not be found/i);
    await expect(guest.query(api.media.myMedia, { eventId })).rejects.toThrow(
      /could not be found/i,
    );
  });

  it("expires the revoked guest's outstanding upload grants", async () => {
    // The capability that outlives a membership: `completeUpload` validates the
    // grant, not the seat.
    const grantId = await t.run(async (ctx) =>
      ctx.db.insert("uploadGrants", {
        eventId,
        userId: guestId,
        captureId: "capture-abcdefgh",
        secretHash: "d".repeat(64),
        status: "issued",
        mediaType: "photo",
        fromLibrary: false,
        storageRegion: "pdx1",
        byteSize: 1024,
        mimeType: "image/jpeg",
        checksum: "e".repeat(64),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.invites.rotate, { eventId, keepExistingMemberships: false });

    expect((await t.run(async (ctx) => ctx.db.get(grantId)))?.status).toBe("expired");
  });

  it("refuses the revoked guest the old code and admits them on the new one", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const rotated = await as.mutation(api.invites.rotate, {
      eventId,
      keepExistingMemberships: false,
    });

    const guest = t.withIdentity({ subject: "guest" });

    // The old code is dead for everybody, and a revoked membership is refused
    // even on a valid credential — a re-scan must not undo a removal.
    const old = await guest.mutation(api.join.join, {
      invite: { via: "code", code: "482913" },
    });
    expect(old.outcome).toBe("rejected");

    // …and the new code lets them back in, which is the "can rejoin only via a
    // new code" half of the requirement.
    const fresh = await guest.mutation(api.join.join, {
      invite: { via: "code", code: rotated.code },
    });
    expect(fresh.outcome).toBe("joined");
  });

  it("lets a co-host rotate", async () => {
    const as = t.withIdentity({ subject: "cohost" });
    const result = await as.mutation(api.invites.rotate, { eventId });
    expect(result.code).not.toBe("482913");
  });

  it("refuses a guest, and refuses a host whose own account is locked", async () => {
    await expect(
      t.withIdentity({ subject: "guest" }).mutation(api.invites.rotate, { eventId }),
    ).rejects.toThrow(/permission/i);

    await t.run(async (ctx) => ctx.db.patch(cohostId, { accountState: "locked" }));
    await expect(
      t.withIdentity({ subject: "cohost" }).mutation(api.invites.rotate, { eventId }),
    ).rejects.toThrow(/cannot rotate/i);
  });
});

describe("invites.rotate — the budget", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  it(`allows ${ROTATION_POLICY.maxPerWindow} rotations an hour and refuses the next`, async () => {
    const as = t.withIdentity({ subject: "owner" });
    for (let index = 0; index < ROTATION_POLICY.maxPerWindow; index += 1) {
      await as.mutation(api.invites.rotate, { eventId });
    }

    await expect(as.mutation(api.invites.rotate, { eventId })).rejects.toThrow(
      /rotated several times/i,
    );

    // The refusal costs nothing: the budget counts successes.
    const row = await t.run(async (ctx) => ctx.db.query("rotationAttempts").first());
    expect(row?.count).toBe(ROTATION_POLICY.maxPerWindow);
  });

  it("lets the window roll over", async () => {
    const as = t.withIdentity({ subject: "owner" });
    for (let index = 0; index < ROTATION_POLICY.maxPerWindow; index += 1) {
      await as.mutation(api.invites.rotate, { eventId });
    }

    // Wind the window back rather than the clock forward — the same trick the
    // join- and upload-throttle suites use, and the only one that does not make
    // the test take an hour.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("rotationAttempts").first();
      if (row) {
        await ctx.db.patch(row._id, {
          windowStartedAt: Date.now() - ROTATION_POLICY.windowMs - 1,
        });
      }
    });

    const result = await as.mutation(api.invites.rotate, { eventId });
    expect(result.version).toBe(ROTATION_POLICY.maxPerWindow + 2);
  });

  it("budgets per event, not per account", async () => {
    const second = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, second, ownerId, { code: "123457" });

    const as = t.withIdentity({ subject: "owner" });
    for (let index = 0; index < ROTATION_POLICY.maxPerWindow; index += 1) {
      await as.mutation(api.invites.rotate, { eventId });
    }
    await expect(as.mutation(api.invites.rotate, { eventId })).rejects.toThrow(/rotated several/i);

    // One compromised party must not stop a host rotating a different one.
    await as.mutation(api.invites.rotate, { eventId: second });
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep marker as a decision, not a memory                               */
/* -------------------------------------------------------------------------- */

/**
 * `memberships.revokedByRotation` means **"swept, and not since re-decided"**.
 *
 * That definition is what makes the join path safe to be lenient about a sweep
 * (a reprinted sign is not a ban) while still refusing a removal. The flag was
 * only ever *set*, never cleared or overwritten, and two things fell out of it:
 *
 * 1. **A removed co-host could restore their own seat.** Guest joins → owner
 *    rotates with revoke → owner invites that address as a co-host → owner
 *    removes them. The re-invitation reactivated the row without clearing the
 *    stale `revokedByRotation: true`, the removal never wrote it, so the join
 *    path read a *sweep* where a host had made a *removal* — and `admit`
 *    inherited the row's old `role`, so they came back as a co-host holding the
 *    moderation queue and `event.rotateInvite`.
 * 2. **A swept guest could not be banned at all**, because both removal
 *    mutations no-op'd on a non-`active` membership and returned "nothing to do".
 */
describe("a sweep is not a permanent decision, and a removal is", () => {
  let t: T;
  let ownerId: Id<"users">;
  let personId: Id<"users">;
  let eventId: Id<"events">;
  const address = "returner@partybooth.test";

  async function membership() {
    return await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", personId))
        .unique(),
    );
  }

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    setSiteUrl();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    personId = await seedUser(t, {
      authId: "person",
      email: address,
      // Verified, because co-host matching binds on a *proven* address.
      emailVerified: true,
    });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  afterEach(() => {
    clearFakeStorage();
    setSiteUrl(undefined);
  });

  it("lets a swept guest back in on the new code", async () => {
    await t
      .withIdentity({ subject: "person" })
      .mutation(api.join.join, { invite: { via: "code", code: "482913" } });

    const rotated = await t
      .withIdentity({ subject: "owner" })
      .mutation(api.invites.rotate, { eventId, keepExistingMemberships: false });
    expect((await membership())?.revokedByRotation).toBe(true);

    const back = await t
      .withIdentity({ subject: "person" })
      .mutation(api.join.join, { invite: { via: "code", code: rotated.code } });
    expect(back.outcome).toBe("joined");
    // Back as a guest, and the marker is gone: the next removal is a decision.
    expect(back.outcome === "joined" ? back.role : null).toBe("guest");
    expect((await membership())?.revokedByRotation).toBeUndefined();
  });

  /** The four-step chain, end to end. */
  it("does not let a removed co-host walk back in by re-scanning the QR", async () => {
    // 1. They join as a guest.
    await t
      .withIdentity({ subject: "person" })
      .mutation(api.join.join, { invite: { via: "code", code: "482913" } });

    // 2. The owner rotates and sweeps the guest list.
    const rotated = await t
      .withIdentity({ subject: "owner" })
      .mutation(api.invites.rotate, { eventId, keepExistingMemberships: false });
    expect((await membership())?.revokedByRotation).toBe(true);

    // 3. The owner invites the same address as a co-host, and they accept.
    await t.run(async (ctx) =>
      ctx.db.insert("cohostInvitations", {
        eventId,
        email: address,
        status: "pending",
        invitedByUserId: ownerId,
        token: "TOKEN0123456789ABCDEF",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      }),
    );
    await t.withIdentity({ subject: "person" }).mutation(api.users.refreshRoles, {});
    expect((await membership())?.role).toBe("cohost");
    // The stale sweep marker must not survive the reactivation.
    expect((await membership())?.revokedByRotation).toBeUndefined();

    // 4. The owner changes their mind and removes them.
    const removal = await t
      .withIdentity({ subject: "owner" })
      .mutation(api.cohosts.remove, { eventId, userId: personId, reason: "Changed my mind" });
    expect(removal.revokedMembership).toBe(true);
    expect((await membership())?.revokedByRotation).toBe(false);

    // …and the QR on the wall does not undo it.
    const retry = await t
      .withIdentity({ subject: "person" })
      .mutation(api.join.join, { invite: { via: "code", code: rotated.code } });
    expect(retry.outcome).toBe("rejected");
    expect((await membership())?.status).toBe("revoked");
    expect((await membership())?.role).toBe("cohost");
  });

  it("lets a swept guest be banned for good", async () => {
    await t
      .withIdentity({ subject: "person" })
      .mutation(api.join.join, { invite: { via: "code", code: "482913" } });
    const rotated = await t
      .withIdentity({ subject: "owner" })
      .mutation(api.invites.rotate, { eventId, keepExistingMemberships: false });

    // A swept row is not `active`, and refusing to touch it meant a guest in
    // this state could never be removed — the ban silently did nothing.
    const removal = await t
      .withIdentity({ subject: "owner" })
      .mutation(api.cohosts.remove, { eventId, userId: personId, reason: "Not welcome back" });
    expect(removal.revokedMembership).toBe(true);
    expect((await membership())?.revokedByRotation).toBe(false);

    const retry = await t
      .withIdentity({ subject: "person" })
      .mutation(api.join.join, { invite: { via: "code", code: rotated.code } });
    expect(retry.outcome).toBe("rejected");
  });
});
