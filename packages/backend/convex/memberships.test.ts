import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { settleAfterProcessing } from "./lib/media";
import {
  ADMIN_EMAIL,
  api,
  auditActions,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMedia,
  seedMembership,
  seedUser,
  setAllowlist,
  useFakeStorage,
} from "./testing.helpers";

afterEach(() => {
  clearFakeStorage();
  setAllowlist(undefined);
});

async function fixture() {
  const t = makeTest();
  useFakeStorage();
  const ownerId = await seedUser(t, {
    authId: "owner",
    email: "owner@partybooth.test",
    displayName: "Host",
  });
  const cohostId = await seedUser(t, {
    authId: "cohost",
    email: "cohost@partybooth.test",
    displayName: "Co-host",
  });
  const firstGuestId = await seedUser(t, {
    authId: "first",
    email: "first@partybooth.test",
    displayName: "Alex",
  });
  const secondGuestId = await seedUser(t, {
    authId: "second",
    email: "second@partybooth.test",
    displayName: "Billie",
  });
  const eventId = await seedEvent(t, ownerId, { state: "live", moderationMode: "manual" });
  await seedMembership(t, eventId, cohostId, "cohost");
  const firstMembershipId = await seedMembership(t, eventId, firstGuestId, "guest");
  const secondMembershipId = await seedMembership(t, eventId, secondGuestId, "guest");
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(firstMembershipId, { joinedAt: now - 10_000 });
    await ctx.db.patch(secondMembershipId, { joinedAt: now });
  });
  const invite = await seedInviteVersion(t, eventId, ownerId);
  return {
    t,
    ownerId,
    cohostId,
    firstGuestId,
    secondGuestId,
    firstMembershipId,
    secondMembershipId,
    eventId,
    invite,
  };
}

describe("memberships.guests", () => {
  it("returns active guests newest first with upload activity and trust settings", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.firstGuestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.firstGuestId, { state: "pending" });
    await seedMedia(f.t, f.eventId, f.secondGuestId, { state: "deleted" });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.firstMembershipId, { autoApproveMedia: true });
    });

    const guests = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.memberships.guests, { eventId: f.eventId });

    expect(guests.map((guest) => guest.displayName)).toEqual(["Billie", "Alex"]);
    expect(guests[1]).toMatchObject({
      userId: f.firstGuestId,
      autoApproveMedia: true,
      submissionCount: 2,
      approvedCount: 1,
    });
    expect(guests[0]).toMatchObject({ submissionCount: 0, approvedCount: 0 });
  });

  it("is host-only and does not expose named activity to a global admin", async () => {
    const f = await fixture();
    await expect(
      f.t.withIdentity({ subject: "first" }).query(api.memberships.guests, { eventId: f.eventId }),
    ).rejects.toThrow(/permission/i);

    setAllowlist(ADMIN_EMAIL);
    await seedUser(f.t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    await expect(
      f.t.withIdentity({ subject: "admin" }).query(api.memberships.guests, { eventId: f.eventId }),
    ).rejects.toThrow(/permission/i);
  });
});

describe("memberships.setAutoApprove", () => {
  it("audits the setting and sends that guest's future uploads straight to approved", async () => {
    const f = await fixture();
    await f.t.withIdentity({ subject: "owner" }).mutation(api.memberships.setAutoApprove, {
      eventId: f.eventId,
      userId: f.firstGuestId,
      enabled: true,
    });

    const mediaId = await seedMedia(f.t, f.eventId, f.firstGuestId, { state: "processing" });
    const settled = await f.t.run(async (ctx) => {
      const media = await ctx.db.get(mediaId);
      const event = await ctx.db.get(f.eventId);
      if (!media || !event) throw new Error("fixture vanished");
      return await settleAfterProcessing(ctx, media, event, Date.now());
    });

    expect(settled).toBe("approved");
    expect(await auditActions(f.t)).toContain(AUDIT_ACTIONS.membershipAutoApproveChanged);
  });

  it("lets a co-host manage guest trust but refuses a guest", async () => {
    const f = await fixture();
    await expect(
      f.t.withIdentity({ subject: "cohost" }).mutation(api.memberships.setAutoApprove, {
        eventId: f.eventId,
        userId: f.firstGuestId,
        enabled: true,
      }),
    ).resolves.toEqual({ enabled: true });

    await expect(
      f.t.withIdentity({ subject: "first" }).mutation(api.memberships.setAutoApprove, {
        eventId: f.eventId,
        userId: f.secondGuestId,
        enabled: true,
      }),
    ).rejects.toThrow(/permission/i);
  });
});

describe("memberships.removeGuest", () => {
  it("removes a guest immediately but permits a fresh scan of the current QR", async () => {
    const f = await fixture();
    const removed = await f.t
      .withIdentity({ subject: "owner" })
      .mutation(api.memberships.removeGuest, {
        eventId: f.eventId,
        userId: f.firstGuestId,
        action: "remove",
        reason: "They left early",
      });
    expect(removed).toMatchObject({ revoked: true, rejoinAllowed: true });

    const joined = await f.t.withIdentity({ subject: "first" }).mutation(api.join.join, {
      invite: { via: "token", token: f.invite.token },
    });
    expect(joined).toMatchObject({ outcome: "joined", eventId: f.eventId });
  });

  it("bans a guest from rejoining even with the current credential", async () => {
    const f = await fixture();
    await f.t.withIdentity({ subject: "cohost" }).mutation(api.memberships.removeGuest, {
      eventId: f.eventId,
      userId: f.secondGuestId,
      action: "ban",
      reason: "Repeated abusive behaviour",
    });

    const result = await f.t.withIdentity({ subject: "second" }).mutation(api.join.join, {
      invite: { via: "code", code: f.invite.code },
    });
    expect(result.outcome).toBe("rejected");
    const membership = await f.t.run(async (ctx) => ctx.db.get(f.secondMembershipId));
    expect(membership).toMatchObject({
      status: "revoked",
      rejoinAllowed: false,
    });
    expect(membership?.autoApproveMedia).toBeUndefined();
  });

  it("expires outstanding upload grants and requires a meaningful reason", async () => {
    const f = await fixture();
    const grantId = await f.t.run(async (ctx) =>
      ctx.db.insert("uploadGrants", {
        eventId: f.eventId,
        userId: f.firstGuestId,
        captureId: "capture-guest-manager",
        secretHash: "b".repeat(64),
        status: "issued",
        mediaType: "photo",
        fromLibrary: false,
        storageRegion: "pdx1",
        byteSize: 1024,
        mimeType: "image/jpeg",
        checksum: "c".repeat(64),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await expect(
      f.t.withIdentity({ subject: "owner" }).mutation(api.memberships.removeGuest, {
        eventId: f.eventId,
        userId: f.firstGuestId,
        action: "ban",
        reason: "",
      }),
    ).rejects.toThrow(/reason/i);

    const result = await f.t
      .withIdentity({ subject: "owner" })
      .mutation(api.memberships.removeGuest, {
        eventId: f.eventId,
        userId: f.firstGuestId,
        action: "ban",
        reason: "Unsafe conduct",
      });
    expect(result.expiredGrants).toBe(1);
    expect((await f.t.run(async (ctx) => ctx.db.get(grantId)))?.status).toBe("expired");
  });
});
