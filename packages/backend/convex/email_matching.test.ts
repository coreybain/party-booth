import { AUDIT_ACTIONS, OTP_POLICY } from "@partybooth/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import { applyVerifiedEmailMatching, createCohostInvitation } from "./lib/email_matching";
import {
  api,
  auditActions,
  internal,
  makeTest,
  seedEvent,
  seedMembership,
  seedUser,
  type T,
} from "./testing.helpers";

const DAY = 24 * 60 * 60 * 1000;

async function seedOrganiserInvitation(
  t: T,
  email: string,
  invitedByUserId: Id<"users">,
  over: { expiresAt?: number; status?: "pending" | "accepted" | "revoked" | "expired" } = {},
): Promise<Id<"organiserInvitations">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("organiserInvitations", {
      email,
      token: `token-${email}`,
      status: over.status ?? "pending",
      invitedByUserId,
      expiresAt: over.expiresAt ?? Date.now() + 7 * DAY,
      createdAt: Date.now(),
    }),
  );
}

async function match(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("missing user");
    return await applyVerifiedEmailMatching(ctx, user);
  });
}

/* -------------------------------------------------------------------------- */
/* Organiser invitations                                                      */
/* -------------------------------------------------------------------------- */

describe("organiser invitations", () => {
  let t: T;
  let adminId: Id<"users">;

  beforeEach(async () => {
    t = makeTest();
    adminId = await seedUser(t, { authId: "admin", email: "admin@partybooth.test" });
  });

  it("unlocks event creation for a verified address", async () => {
    const userId = await seedUser(t, {
      authId: "u1",
      email: "host@partybooth.test",
      isOrganiser: false,
    });
    await seedOrganiserInvitation(t, "host@partybooth.test", adminId);

    const result = await match(t, userId);

    expect(result.organiserUnlocked).toBe(true);
    expect((await t.run(async (ctx) => ctx.db.get(userId)))?.isOrganiser).toBe(true);
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.organiserInviteAccepted);
  });

  it("ignores an unverified address — this is the whole security property", async () => {
    // Otherwise anyone who can type someone else's address into a sign-up form
    // inherits whatever was waiting for it.
    const userId = await seedUser(t, {
      authId: "u1",
      email: "host@partybooth.test",
      emailVerified: false,
      isOrganiser: false,
    });
    await seedOrganiserInvitation(t, "host@partybooth.test", adminId);

    expect((await match(t, userId)).organiserUnlocked).toBe(false);
    expect((await t.run(async (ctx) => ctx.db.get(userId)))?.isOrganiser).toBe(false);
  });

  it("expires an invitation that timed out instead of honouring it", async () => {
    const userId = await seedUser(t, {
      authId: "u1",
      email: "host@partybooth.test",
      isOrganiser: false,
    });
    const invitationId = await seedOrganiserInvitation(t, "host@partybooth.test", adminId, {
      expiresAt: Date.now() - 1,
    });

    expect((await match(t, userId)).organiserUnlocked).toBe(false);
    expect((await t.run(async (ctx) => ctx.db.get(invitationId)))?.status).toBe("expired");
  });

  it("is idempotent — the invitation is consumed by being accepted", async () => {
    const userId = await seedUser(t, {
      authId: "u1",
      email: "host@partybooth.test",
      isOrganiser: false,
    });
    await seedOrganiserInvitation(t, "host@partybooth.test", adminId);

    await match(t, userId);
    expect((await match(t, userId)).organiserUnlocked).toBe(false);
    const rows = await t.run(async (ctx) => ctx.db.query("organiserInvitations").collect());
    expect(rows.filter((row) => row.status === "accepted")).toHaveLength(1);
  });

  it("does nothing for a locked account", async () => {
    const userId = await seedUser(t, {
      authId: "u1",
      email: "host@partybooth.test",
      isOrganiser: false,
      accountState: "locked",
    });
    await seedOrganiserInvitation(t, "host@partybooth.test", adminId);
    expect((await match(t, userId)).organiserUnlocked).toBe(false);
  });

  it("keeps addresses out of the audit metadata", async () => {
    const userId = await seedUser(t, {
      authId: "u1",
      email: "host@partybooth.test",
      isOrganiser: false,
    });
    await seedOrganiserInvitation(t, "host@partybooth.test", adminId);
    await match(t, userId);

    const rows = await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(JSON.stringify(rows)).not.toContain("host@partybooth.test");
  });
});

/* -------------------------------------------------------------------------- */
/* Co-host invitations                                                        */
/* -------------------------------------------------------------------------- */

describe("co-host invitations", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
  });

  async function invite(email: string): Promise<void> {
    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      if (!event) throw new Error("missing event");
      await createCohostInvitation(ctx, { event, email, invitedByUserId: ownerId });
    });
  }

  it("elevates a verified address to a co-host membership", async () => {
    const userId = await seedUser(t, { authId: "co", email: "co@partybooth.test" });
    await invite("co@partybooth.test");

    const result = await match(t, userId);
    expect(result.cohostEventIds).toEqual([eventId]);

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", userId))
        .unique(),
    );
    expect(membership?.role).toBe("cohost");
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.cohostInviteAccepted);
  });

  it("upgrades an existing guest rather than creating a second row", async () => {
    const userId = await seedUser(t, { authId: "co", email: "co@partybooth.test" });
    await seedMembership(t, eventId, userId, "guest");
    await invite("co@partybooth.test");

    await match(t, userId);

    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", userId))
        .collect(),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("cohost");
  });

  it("does not demote the owner", async () => {
    await invite("owner@partybooth.test");
    await match(t, ownerId);
    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", ownerId))
        .unique(),
    );
    expect(membership?.role).toBe("owner");
  });

  it("ignores an unverified address", async () => {
    const userId = await seedUser(t, {
      authId: "co",
      email: "co@partybooth.test",
      emailVerified: false,
    });
    await invite("co@partybooth.test");
    expect((await match(t, userId)).cohostEventIds).toEqual([]);
  });

  it("refreshes rather than stacking a duplicate invitation", async () => {
    await invite("co@partybooth.test");
    await invite("co@partybooth.test");
    const rows = await t.run(async (ctx) => ctx.db.query("cohostInvitations").collect());
    expect(rows).toHaveLength(1);
  });

  it("does not hand out a seat on an event that is being deleted", async () => {
    const userId = await seedUser(t, { authId: "co", email: "co@partybooth.test" });
    await invite("co@partybooth.test");
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "deletionScheduled" }));
    expect((await match(t, userId)).cohostEventIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* users.refreshRoles                                                         */
/* -------------------------------------------------------------------------- */

describe("users.refreshRoles", () => {
  it("lets a client pick up an invitation issued after they signed in", async () => {
    const t = makeTest();
    const adminId = await seedUser(t, { authId: "admin", email: "admin@partybooth.test" });
    await seedUser(t, { authId: "u1", email: "host@partybooth.test", isOrganiser: false });

    const as = t.withIdentity({ subject: "u1" });
    expect((await as.mutation(api.users.refreshRoles, {})).isOrganiser).toBe(false);

    await seedOrganiserInvitation(t, "host@partybooth.test", adminId);

    const after = await as.mutation(api.users.refreshRoles, {});
    expect(after).toMatchObject({ isOrganiser: true, organiserUnlocked: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Apple private relay: proving a second address                              */
/* -------------------------------------------------------------------------- */

describe("email verification (the Apple private-relay path)", () => {
  let t: T;
  let adminId: Id<"users">;
  let relayUserId: Id<"users">;

  beforeEach(async () => {
    t = makeTest();
    adminId = await seedUser(t, { authId: "admin", email: "admin@partybooth.test" });
    relayUserId = await seedUser(t, {
      authId: "relay",
      email: "abc123@privaterelay.appleid.com",
      isPrivateRelayEmail: true,
      isOrganiser: false,
    });
  });

  async function issue(email: string): Promise<string> {
    const issued = await t.mutation(internal.emails.issueChallenge, {
      authId: "relay",
      email,
    });
    if (!issued.allowed) throw new Error(`refused: ${issued.reason}`);
    return issued.code;
  }

  it("sends a code end to end through the action", async () => {
    // The console sender reports success on a development deployment, which is
    // what an empty environment resolves to — so the whole path is exercisable
    // offline, right up to the point where Resend would take over.
    const as = t.withIdentity({ subject: "relay" });
    await expect(
      as.action(api.emails.requestVerification, { email: "real@partybooth.test" }),
    ).resolves.toBeNull();

    const row = await t.run(async (ctx) => ctx.db.query("userEmails").first());
    expect(row?.email).toBe("real@partybooth.test");
    expect(row?.status).toBe("pending");
  });

  it("refuses a signed-out caller", async () => {
    await expect(
      t.action(api.emails.requestVerification, { email: "real@partybooth.test" }),
    ).rejects.toThrow(/sign in/i);
  });

  it("stores the code hashed, never in the clear", async () => {
    const code = await issue("real@partybooth.test");
    const row = await t.run(async (ctx) => ctx.db.query("userEmails").first());
    expect(row?.status).toBe("pending");
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it("verifies the address and runs matching against it", async () => {
    await seedOrganiserInvitation(t, "real@partybooth.test", adminId);
    const code = await issue("real@partybooth.test");

    const as = t.withIdentity({ subject: "relay" });
    const result = await as.mutation(api.emails.confirmVerification, {
      email: "real@partybooth.test",
      code,
    });

    expect(result).toMatchObject({ ok: true, organiserUnlocked: true });
    expect((await t.run(async (ctx) => ctx.db.get(relayUserId)))?.isOrganiser).toBe(true);
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.accountEmailVerified);
  });

  it("burns the code on success", async () => {
    const code = await issue("real@partybooth.test");
    const as = t.withIdentity({ subject: "relay" });
    await as.mutation(api.emails.confirmVerification, { email: "real@partybooth.test", code });

    const row = await t.run(async (ctx) => ctx.db.query("userEmails").first());
    expect(row?.status).toBe("verified");
    expect(row?.codeHash).toBeUndefined();

    expect(
      await as.mutation(api.emails.confirmVerification, { email: "real@partybooth.test", code }),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("gives the same answer for a wrong code and an unknown address", async () => {
    await issue("real@partybooth.test");
    const as = t.withIdentity({ subject: "relay" });
    const wrongCode = await as.mutation(api.emails.confirmVerification, {
      email: "real@partybooth.test",
      code: "000001",
    });
    const unknownAddress = await as.mutation(api.emails.confirmVerification, {
      email: "never-asked@partybooth.test",
      code: "000001",
    });
    expect(wrongCode).toEqual(unknownAddress);
  });

  it("spends the five-guess budget and then stops", async () => {
    // A regression guard with teeth: a Convex mutation that *throws* rolls its
    // own writes back, so an implementation that threw on a wrong code would
    // never persist the counter and this budget would be infinite.
    await issue("real@partybooth.test");
    const as = t.withIdentity({ subject: "relay" });
    for (let i = 0; i < OTP_POLICY.maxAttempts; i += 1) {
      expect(
        await as.mutation(api.emails.confirmVerification, {
          email: "real@partybooth.test",
          code: "000001",
        }),
      ).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(
      await as.mutation(api.emails.confirmVerification, {
        email: "real@partybooth.test",
        code: "000001",
      }),
    ).toMatchObject({ ok: false, reason: "tooManyAttempts" });
  });

  it("refuses an expired code", async () => {
    const code = await issue("real@partybooth.test");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("userEmails").first();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    const as = t.withIdentity({ subject: "relay" });
    expect(
      await as.mutation(api.emails.confirmVerification, { email: "real@partybooth.test", code }),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("shares the OTP send counter, so this is not an unthrottled mailer", async () => {
    const now = Date.now();
    // The 15-second cooldown from OTP_POLICY applies to the second request.
    await t.mutation(internal.emails.issueChallenge, {
      authId: "relay",
      email: "real@partybooth.test",
      now,
    });
    const second = await t.mutation(internal.emails.issueChallenge, {
      authId: "relay",
      email: "real@partybooth.test",
      now: now + 1000,
    });
    expect(second.allowed).toBe(false);
    if (second.allowed) throw new Error("unreachable");
    expect(second.reason).toBe("cooldown");
  });

  it("lists the addresses this account has claimed", async () => {
    const code = await issue("real@partybooth.test");
    const as = t.withIdentity({ subject: "relay" });
    await as.mutation(api.emails.confirmVerification, { email: "real@partybooth.test", code });
    expect(await as.query(api.emails.myEmails, {})).toEqual([
      { email: "real@partybooth.test", status: "verified", verifiedAt: expect.any(Number) },
    ]);
  });
});
