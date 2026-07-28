import { AUDIT_ACTIONS, JOIN_POLICY, JOIN_REJECTED_MESSAGE } from "@partybooth/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  auditRows,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMembership,
  seedUser,
  type T,
} from "./testing.helpers";

const HOUR = 60 * 60 * 1000;
const TOKEN = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const CODE = "482913";

/** Burn the failure budget for the signed-in guest. */
async function exhaustBudget(t: T, subject: string): Promise<void> {
  const as = t.withIdentity({ subject });
  for (let i = 0; i < JOIN_POLICY.maxFailuresPerWindow; i += 1) {
    await as.mutation(api.join.join, { invite: { via: "code", code: "999888" } });
  }
}

describe("join.join", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: CODE, token: TOKEN });
  });

  it("admits a guest by code", async () => {
    const as = t.withIdentity({ subject: "guest" });
    const result = await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });

    expect(result).toMatchObject({ outcome: "joined", eventId, role: "guest" });
    if (result.outcome !== "joined") throw new Error("unreachable");
    expect(result.alreadyMember).toBe(false);

    const membership = await t.run(async (ctx) => ctx.db.get(result.membershipId));
    expect(membership?.status).toBe("active");
    expect(membership?.inviteVersionId).toBeDefined();
  });

  it("admits a guest by QR token, and tolerates the transcription mistakes", async () => {
    const as = t.withIdentity({ subject: "guest" });
    // Lower case, spaced, with the I/L/O family the Crockford alphabet folds.
    const typed = TOKEN.toLowerCase().replace(/^(.{8})/, "$1 ");
    const result = await as.mutation(api.join.join, { invite: { via: "token", token: typed } });
    expect(result.outcome).toBe("joined");
  });

  it("accepts a code with the formatting people type", async () => {
    const as = t.withIdentity({ subject: "guest" });
    const result = await as.mutation(api.join.join, {
      invite: { via: "code", code: "48 29-13" },
    });
    expect(result.outcome).toBe("joined");
  });

  it("is idempotent — a second scan changes nothing", async () => {
    const as = t.withIdentity({ subject: "guest" });
    const first = await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });
    const second = await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });

    expect(second).toMatchObject({ outcome: "joined", alreadyMember: true });
    if (first.outcome !== "joined" || second.outcome !== "joined") throw new Error("unreachable");
    expect(second.membershipId).toBe(first.membershipId);

    const created = (await auditRows(t)).filter(
      (row) => row.action === AUDIT_ACTIONS.membershipCreated,
    );
    expect(created).toHaveLength(1);
  });

  it("points the guest's active event at the party they just walked into", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });
    expect((await t.run(async (ctx) => ctx.db.get(guestId)))?.activeEventId).toBe(eventId);
  });

  it("audits a successful join", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });
    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.membershipCreated);
    expect(row?.eventId).toBe(eventId);
    expect(row?.metadata).toMatchObject({ via: "code", inviteVersion: 1 });
  });

  it("refuses a signed-out caller", async () => {
    await expect(
      t.mutation(api.join.join, { invite: { via: "code", code: CODE } }),
    ).rejects.toThrow(/sign in/i);
  });

  it("refuses a locked account", async () => {
    await seedUser(t, {
      authId: "locked",
      email: "locked@partybooth.test",
      accountState: "locked",
    });
    const as = t.withIdentity({ subject: "locked" });
    await expect(
      as.mutation(api.join.join, { invite: { via: "code", code: CODE } }),
    ).rejects.toThrow(/suspended/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Enumeration protection                                                     */
/* -------------------------------------------------------------------------- */

describe("join rejections are indistinguishable", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
  });

  async function attempt(code: string): Promise<unknown> {
    const as = t.withIdentity({ subject: "guest" });
    return await as.mutation(api.join.join, { invite: { via: "code", code } });
  }

  it("gives the same answer for an unknown code, a revoked version and a draft event", async () => {
    // Three genuinely different situations, one response.
    const draft = await seedEvent(t, ownerId, { state: "draft" });
    await seedInviteVersion(t, draft, ownerId, { code: "111222", token: `${TOKEN.slice(0, 31)}A` });
    await seedInviteVersion(t, eventId, ownerId, {
      code: "333444",
      token: `${TOKEN.slice(0, 31)}B`,
      status: "revoked",
      makeActive: false,
    });

    const unknown = await attempt("555666");
    const revoked = await attempt("333444");
    const notLive = await attempt("111222");

    const expected = { outcome: "rejected", message: JOIN_REJECTED_MESSAGE };
    expect(unknown).toEqual(expected);
    expect(revoked).toEqual(expected);
    expect(notLive).toEqual(expected);
  });

  it("records the real reason in the audit log, where only we can see it", async () => {
    await seedInviteVersion(t, eventId, ownerId, {
      code: "333444",
      status: "revoked",
      makeActive: false,
    });
    await attempt("333444");
    await attempt("555666");

    const reasons = (await auditRows(t))
      .filter((row) => row.action === AUDIT_ACTIONS.joinRejected)
      .map((row) => row.metadata?.["reason"]);
    expect(reasons).toEqual(["revokedVersion", "unknownCredential"]);
  });

  it("rejects a join against a superseded version after rotation", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: CODE, token: TOKEN });
    const asOwner = t.withIdentity({ subject: "owner" });
    const rotated = await asOwner.mutation(api.invites.rotate, { eventId });

    // The poster on the wall is dead.
    expect(await attempt(CODE)).toEqual({
      outcome: "rejected",
      message: JOIN_REJECTED_MESSAGE,
    });
    // The new one works.
    expect(await attempt(rotated.code)).toMatchObject({ outcome: "joined" });
  });

  it("rejects a join outside the schedule window", async () => {
    const past = await seedEvent(t, ownerId, {
      state: "live",
      startsAt: Date.now() - 100 * HOUR,
      endsAt: Date.now() - 50 * HOUR,
    });
    await seedInviteVersion(t, past, ownerId, { code: "777888", token: `${TOKEN.slice(0, 31)}C` });

    expect(await attempt("777888")).toEqual({
      outcome: "rejected",
      message: JOIN_REJECTED_MESSAGE,
    });
    const reasons = (await auditRows(t))
      .filter((row) => row.action === AUDIT_ACTIONS.joinRejected)
      .map((row) => row.metadata?.["reason"]);
    expect(reasons).toEqual(["outsideWindow"]);
  });

  it("does not let a revoked member back in with a fresh scan", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: CODE, token: TOKEN });
    const exGuestId = await seedUser(t, { authId: "ex", email: "ex@partybooth.test" });
    await seedMembership(t, eventId, exGuestId, "guest", "revoked");

    const as = t.withIdentity({ subject: "ex" });
    expect(await as.mutation(api.join.join, { invite: { via: "code", code: CODE } })).toEqual({
      outcome: "rejected",
      message: JOIN_REJECTED_MESSAGE,
    });
  });

  it("lets somebody who left come back", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: CODE, token: TOKEN });
    const leaverId = await seedUser(t, { authId: "left", email: "left@partybooth.test" });
    await seedMembership(t, eventId, leaverId, "guest", "left");

    const as = t.withIdentity({ subject: "left" });
    expect(await as.mutation(api.join.join, { invite: { via: "code", code: CODE } })).toMatchObject(
      { outcome: "joined", alreadyMember: false },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Throttle                                                                   */
/* -------------------------------------------------------------------------- */

describe("join throttle", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: CODE, token: TOKEN });
  });

  it("locks a guesser out after the ceiling and says how long", async () => {
    await exhaustBudget(t, "guest");
    const as = t.withIdentity({ subject: "guest" });
    const result = await as.mutation(api.join.join, {
      invite: { via: "code", code: "111222" },
    });

    expect(result.outcome).toBe("throttled");
    if (result.outcome !== "throttled") throw new Error("unreachable");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("refuses even the correct code once locked out", async () => {
    // The lockout is on the attempt, not on the answer — otherwise a hit at
    // guess 11 would still be a hit.
    await exhaustBudget(t, "guest");
    const as = t.withIdentity({ subject: "guest" });
    expect(
      (await as.mutation(api.join.join, { invite: { via: "code", code: CODE } })).outcome,
    ).toBe("throttled");
  });

  it("throttles per account, not globally", async () => {
    await seedUser(t, { authId: "other", email: "other@partybooth.test" });
    await exhaustBudget(t, "guest");
    const as = t.withIdentity({ subject: "other" });
    expect(
      (await as.mutation(api.join.join, { invite: { via: "code", code: CODE } })).outcome,
    ).toBe("joined");
  });

  it("hands the budget back on a success, so a mistype costs nothing", async () => {
    const as = t.withIdentity({ subject: "guest" });
    for (let i = 0; i < JOIN_POLICY.maxFailuresPerWindow - 1; i += 1) {
      await as.mutation(api.join.join, { invite: { via: "code", code: "999888" } });
    }
    await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });

    const attempts = await t.run(async (ctx) => ctx.db.query("joinAttempts").collect());
    expect(attempts).not.toHaveLength(0);
    expect(attempts.every((attempt) => attempt.failureCount === 0)).toBe(true);
    expect(attempts.every((attempt) => attempt.lockedUntil === undefined)).toBe(true);
  });

  it("also charges a network key when the caller supplies one", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.join.join, {
      invite: { via: "code", code: "999888" },
      networkKey: "203.0.113.7",
    });
    const keys = await t.run(async (ctx) =>
      (await ctx.db.query("joinAttempts").collect()).map((row) => row.key),
    );
    expect(keys.filter((key) => key.startsWith("net:"))).toHaveLength(1);
    // Hashed, never the address itself.
    expect(keys.join()).not.toContain("203.0.113.7");
  });

  it("audits a throttled attempt", async () => {
    await exhaustBudget(t, "guest");
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });

    const reasons = (await auditRows(t))
      .filter((row) => row.action === AUDIT_ACTIONS.joinRejected)
      .map((row) => row.metadata?.["reason"]);
    expect(reasons.at(-1)).toBe("throttled");
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

describe("join previews", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, {
      authId: "owner",
      email: "owner@partybooth.test",
      displayName: "Corey",
    });
    await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "scheduled", name: "Summer party" });
    await seedInviteVersion(t, eventId, ownerId, { code: CODE, token: TOKEN });
  });

  it("previews from a QR token without signing in — the token is unguessable", async () => {
    const preview = await t.query(api.join.previewByToken, { token: TOKEN });
    expect(preview).toMatchObject({ name: "Summer party", hostDisplayName: "Corey" });
  });

  it("says nothing beyond what the poster already says", async () => {
    const preview = await t.query(api.join.previewByToken, { token: TOKEN });
    expect(Object.keys(preview ?? {}).sort()).toEqual(
      [
        "alreadyMember",
        "eventId",
        "hostDisplayName",
        "name",
        "startsAt",
        "state",
        "timeZone",
      ].sort(),
    );
  });

  it("returns null for an unknown or superseded token", async () => {
    expect(await t.query(api.join.previewByToken, { token: `${TOKEN.slice(0, 31)}Z` })).toBeNull();
    const asOwner = t.withIdentity({ subject: "owner" });
    await asOwner.mutation(api.invites.rotate, { eventId });
    expect(await t.query(api.join.previewByToken, { token: TOKEN })).toBeNull();
  });

  it("previews from a typed code, but only for a signed-in caller", async () => {
    const as = t.withIdentity({ subject: "guest" });
    expect(await as.mutation(api.join.previewByCode, { code: CODE })).toMatchObject({
      name: "Summer party",
    });
    await expect(t.mutation(api.join.previewByCode, { code: CODE })).rejects.toThrow(/sign in/i);
  });

  it("spends the same throttle budget as a join", async () => {
    // The reason this is a mutation at all: an unthrottled "is this a real
    // code?" query is the oracle the whole design denies.
    const as = t.withIdentity({ subject: "guest" });
    for (let i = 0; i < JOIN_POLICY.maxFailuresPerWindow; i += 1) {
      await as.mutation(api.join.previewByCode, { code: "999888" });
    }
    expect(await as.mutation(api.join.previewByCode, { code: CODE })).toBeNull();
    expect(
      (await as.mutation(api.join.join, { invite: { via: "code", code: CODE } })).outcome,
    ).toBe("throttled");
  });

  it("tells an existing member they are already in", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.join.join, { invite: { via: "code", code: CODE } });
    expect(await as.mutation(api.join.previewByCode, { code: CODE })).toMatchObject({
      alreadyMember: true,
    });
  });
});
