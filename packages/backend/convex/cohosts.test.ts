import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import { setEmailSender, type EmailMessage, type EmailSender } from "./lib/email";
import {
  api,
  auditActions,
  auditRows,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedMedia,
  seedMembership,
  seedUser,
  setSiteUrl,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * Co-hosts: the invitation, and the permission matrix.
 *
 * The matrix half is the point of this file. PLAN.md and TODO.md say a co-host
 * "operates" the party and may not "delete/transfer/ownership", and the pure
 * rules in `@partybooth/contracts/permissions` are exhaustively tested next to
 * themselves — so what is worth testing *here* is that the **mutations** ask.
 * Every forbidden action is exercised through the real function with a real
 * co-host identity, because a capability nobody consults is a capability that
 * does not exist.
 */

/** A sender that records rather than sending. No network, no credentials. */
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

describe("cohosts.invite", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;
  let mail: ReturnType<typeof recordingSender>;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId);
    mail = recordingSender();
    setEmailSender(mail.sender);
    setSiteUrl();
  });

  afterEach(() => {
    setEmailSender(undefined);
    setSiteUrl(undefined);
  });

  it("writes a pending invitation with a token and an expiry, audits it, and emails", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const result = await as.action(api.cohosts.invite, {
      eventId,
      email: "Co@PartyBooth.test",
    });

    expect(result.emailed).toBe(true);

    const invitation = await t.run(async (ctx) => ctx.db.get(result.invitationId));
    expect(invitation?.status).toBe("pending");
    // Normalised, so matching against a verified address cannot miss on case.
    expect(invitation?.email).toBe("co@partybooth.test");
    expect(invitation?.token).toBeTypeOf("string");
    expect(invitation?.token?.length).toBeGreaterThan(16);
    expect(invitation?.expiresAt).toBeGreaterThan(Date.now());

    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.cohostInvited);

    // The audit row must not become a mailing list.
    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.cohostInvited);
    expect(JSON.stringify(row)).not.toContain("co@partybooth.test");

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe("Co@PartyBooth.test");
    expect(mail.sent[0]?.text).toContain(invitation?.token ?? "no token");
  });

  it("refreshes rather than stacking when the same address is invited twice", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const first = await as.action(api.cohosts.invite, { eventId, email: "co@partybooth.test" });
    const second = await as.action(api.cohosts.invite, { eventId, email: "co@partybooth.test" });

    expect(second.invitationId).toBe(first.invitationId);

    const rows = await t.run(async (ctx) => ctx.db.query("cohostInvitations").collect());
    expect(rows).toHaveLength(1);
    // The token is kept, so the link in the first email keeps working.
    expect(rows[0]?.token).toBeTypeOf("string");
  });

  it("refuses a co-host — only the owner grows the host list", async () => {
    const cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    await seedMembership(t, eventId, cohostId, "cohost");

    const as = t.withIdentity({ subject: "cohost" });
    await expect(
      as.action(api.cohosts.invite, { eventId, email: "third@partybooth.test" }),
    ).rejects.toThrow(/permission/i);

    expect(await t.run(async (ctx) => ctx.db.query("cohostInvitations").collect())).toHaveLength(0);
  });

  it("refuses a guest, and hides the event from a stranger", async () => {
    const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");
    await seedUser(t, { authId: "stranger", email: "who@partybooth.test" });

    await expect(
      t.withIdentity({ subject: "guest" }).action(api.cohosts.invite, {
        eventId,
        email: "x@partybooth.test",
      }),
    ).rejects.toThrow(/permission/i);

    await expect(
      t.withIdentity({ subject: "stranger" }).action(api.cohosts.invite, {
        eventId,
        email: "x@partybooth.test",
      }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("refuses an address that is already a host of this party", async () => {
    const cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    await seedMembership(t, eventId, cohostId, "cohost");

    const as = t.withIdentity({ subject: "owner" });
    await expect(
      as.action(api.cohosts.invite, { eventId, email: "co@partybooth.test" }),
    ).rejects.toThrow(/already a host/i);
  });

  it("refuses to invite the owner's own address", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await expect(
      as.action(api.cohosts.invite, { eventId, email: "owner@partybooth.test" }),
    ).rejects.toThrow(/already the host/i);
  });
});

describe("cohosts.revokeInvitation", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId);
    setEmailSender(recordingSender().sender);
    setSiteUrl();
  });

  afterEach(() => {
    setEmailSender(undefined);
    setSiteUrl(undefined);
  });

  it("moves the row to revoked, burns the token, and stops matching honouring it", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const { invitationId } = await as.action(api.cohosts.invite, {
      eventId,
      email: "co@partybooth.test",
    });

    await as.mutation(api.cohosts.revokeInvitation, {
      invitationId,
      reason: "Wrong address",
    });

    const invitation = await t.run(async (ctx) => ctx.db.get(invitationId));
    expect(invitation?.status).toBe("revoked");
    expect(invitation?.token).toBeUndefined();
    expect(invitation?.revokeReason).toBe("Wrong address");

    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.cohostInviteRevoked);

    // The seam that would otherwise honour it: matching only ever reads
    // `pending` rows, so a sign-in now grants nothing.
    const invitee = await seedUser(t, {
      authId: "invitee",
      email: "co@partybooth.test",
      emailVerified: true,
    });
    await t.withIdentity({ subject: "invitee" }).mutation(api.users.refreshRoles, {});

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", invitee))
        .unique(),
    );
    expect(membership).toBeNull();
  });

  it("refuses a co-host", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const { invitationId } = await as.action(api.cohosts.invite, {
      eventId,
      email: "third@partybooth.test",
    });

    const cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    await seedMembership(t, eventId, cohostId, "cohost");

    await expect(
      t.withIdentity({ subject: "cohost" }).mutation(api.cohosts.revokeInvitation, {
        invitationId,
        reason: "not mine to withdraw",
      }),
    ).rejects.toThrow(/permission/i);
  });
});

describe("cohosts.remove", () => {
  let t: T;
  let ownerId: Id<"users">;
  let cohostId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    cohostId = await seedUser(t, {
      authId: "cohost",
      email: "co@partybooth.test",
      emailVerified: true,
    });
    eventId = await seedEvent(t, ownerId);
    await seedMembership(t, eventId, cohostId, "cohost");
    setEmailSender(recordingSender().sender);
    setSiteUrl();
  });

  afterEach(() => {
    setEmailSender(undefined);
    setSiteUrl(undefined);
  });

  it("revokes the membership, audits it with a reason, and takes the seat away", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.cohosts.remove, {
      eventId,
      userId: cohostId,
      reason: "Left the group",
    });

    expect(result.revokedMembership).toBe(true);

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.membershipRevoked);
    expect(row?.reason).toBe("Left the group");
    expect(row?.metadata).toMatchObject({ via: "cohostRemoval", role: "cohost" });

    // Reactive: the event simply stops existing for them.
    await expect(
      t.withIdentity({ subject: "cohost" }).query(api.events.home, { eventId }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("also revokes a pending invitation to the same address", async () => {
    // Otherwise the next sign-in re-grants the seat that was just taken away.
    // Seeded rather than invited, because `invite` correctly refuses an address
    // that is already a co-host — this is the older row that made them one.
    await t.run(async (ctx) =>
      ctx.db.insert("cohostInvitations", {
        eventId,
        email: "co@partybooth.test",
        status: "pending",
        invitedByUserId: ownerId,
        token: "TOKEN0123456789ABCDEF",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      }),
    );

    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.cohosts.remove, {
      eventId,
      userId: cohostId,
      reason: "Removed",
    });
    expect(result.revokedInvitations).toBe(1);

    await t.withIdentity({ subject: "cohost" }).mutation(api.users.refreshRoles, {});
    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", cohostId))
        .unique(),
    );
    expect(membership?.status).toBe("revoked");
  });

  it("expires the removed host's outstanding upload grants", async () => {
    const grantId = await t.run(async (ctx) =>
      ctx.db.insert("uploadGrants", {
        eventId,
        userId: cohostId,
        captureId: "capture-abcdefgh",
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

    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.cohosts.remove, { eventId, userId: cohostId, reason: "Removed" });

    expect((await t.run(async (ctx) => ctx.db.get(grantId)))?.status).toBe("expired");
  });

  it("refuses a co-host removing another co-host", async () => {
    const otherId = await seedUser(t, { authId: "other", email: "other@partybooth.test" });
    await seedMembership(t, eventId, otherId, "cohost");

    await expect(
      t
        .withIdentity({ subject: "cohost" })
        .mutation(api.cohosts.remove, { eventId, userId: otherId, reason: "mine now" }),
    ).rejects.toThrow(/permission|not available/i);

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", otherId))
        .unique(),
    );
    expect(membership?.status).toBe("active");
  });

  it("refuses anybody removing the owner", async () => {
    await expect(
      t
        .withIdentity({ subject: "cohost" })
        .mutation(api.cohosts.remove, { eventId, userId: ownerId, reason: "coup" }),
    ).rejects.toThrow(/permission|not available/i);

    // …including the owner themselves. Leaving is a transfer, not a removal.
    await expect(
      t
        .withIdentity({ subject: "owner" })
        .mutation(api.cohosts.remove, { eventId, userId: ownerId, reason: "leaving" }),
    ).rejects.toThrow(/permission|not available/i);
  });

  it("lets a co-host remove a guest — PLAN.md risk #4, solo moderation at 1am", async () => {
    const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");

    const result = await t
      .withIdentity({ subject: "cohost" })
      .mutation(api.cohosts.remove, { eventId, userId: guestId, reason: "Abusive" });

    expect(result.revokedMembership).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The forbidden-action matrix, exercised through the real mutations           */
/* -------------------------------------------------------------------------- */

describe("the co-host matrix, through the mutations", () => {
  let t: T;
  let ownerId: Id<"users">;
  let cohostId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, cohostId, "cohost");
    setEmailSender(recordingSender().sender);
    setSiteUrl();
  });

  afterEach(() => {
    clearFakeStorage();
    setEmailSender(undefined);
    setSiteUrl(undefined);
  });

  it("lets a co-host do the things a co-host is for", async () => {
    const as = t.withIdentity({ subject: "cohost" });
    const mediaId = await seedMedia(t, eventId, ownerId, { state: "pending" });

    // Moderate.
    await as.mutation(api.moderation.moderate, {
      eventId,
      mediaIds: [mediaId],
      action: "approve",
    });
    // Settings.
    await as.mutation(api.events.update, { eventId, moderationMode: "automatic" });
    // Slideshow.
    await as.query(api.slideshow.feed, { eventId });
    // Rotation.
    const rotated = await as.mutation(api.invites.rotate, { eventId });
    expect(rotated.version).toBeGreaterThan(0);
    // The invite code.
    expect(await as.query(api.invites.current, { eventId })).not.toBeNull();
  });

  it("refuses every action that changes who owns the party", async () => {
    const as = t.withIdentity({ subject: "cohost" });

    await expect(as.mutation(api.events.setState, { eventId, state: "archived" })).rejects.toThrow(
      /permission/i,
    );

    await expect(
      as.action(api.cohosts.invite, { eventId, email: "third@partybooth.test" }),
    ).rejects.toThrow(/permission/i);

    await expect(
      as.mutation(api.cohosts.remove, { eventId, userId: ownerId, reason: "no" }),
    ).rejects.toThrow(/permission|not available/i);
  });

  it("refuses a co-host every admin-console function", async () => {
    // Not a permission question at all — the allowlist is the gate — but the
    // refusal has to be the same either way, and it has to be tested from the
    // role most likely to try.
    const as = t.withIdentity({ subject: "cohost" });

    await expect(as.query(api.admin.accounts, {})).rejects.toThrow(/permission/i);
    await expect(as.query(api.admin.events, {})).rejects.toThrow(/permission/i);
    await expect(as.query(api.admin.jobHealth, {})).rejects.toThrow(/permission/i);
    await expect(
      as.mutation(api.admin.lockAccount, { userId: ownerId, reason: "because" }),
    ).rejects.toThrow(/permission/i);
  });
});
