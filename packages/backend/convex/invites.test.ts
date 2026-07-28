import { AUDIT_ACTIONS, CodeGenerationError } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import { allocateJoinCode, ensureCodeIsFree, isCodeTaken, mintInviteVersion } from "./lib/events";
import {
  ADMIN_EMAIL,
  api,
  auditRows,
  bytesFor,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMembership,
  seedUser,
  setAllowlist,
  type T,
} from "./testing.helpers";

afterEach(() => {
  setAllowlist(undefined);
});

/* -------------------------------------------------------------------------- */
/* Code allocation                                                            */
/* -------------------------------------------------------------------------- */

describe("code allocation", () => {
  let t: T;
  let ownerId: Id<"users">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
  });

  it("counts a code held by a joinable event as taken", async () => {
    const eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    expect(await t.run(async (ctx) => isCodeTaken(ctx, "482913"))).toBe(true);
  });

  it("frees the code when the event is archived — nothing is rewritten", async () => {
    const eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });

    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "archived" }));

    expect(await t.run(async (ctx) => isCodeTaken(ctx, "482913"))).toBe(false);
    // The row survives, so a join that happened last week is still explicable.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("inviteVersions")
        .withIndex("by_code", (q) => q.eq("code", "482913"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
  });

  it("frees the code when the version is revoked", async () => {
    const eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913", status: "revoked" });
    expect(await t.run(async (ctx) => isCodeTaken(ctx, "482913"))).toBe(false);
  });

  it("ignores the drafting event's own code when told to", async () => {
    const eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    expect(await t.run(async (ctx) => isCodeTaken(ctx, "482913", { ignoreEventId: eventId }))).toBe(
      false,
    );
  });

  it("retries past a collision", async () => {
    const taken = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, taken, ownerId, { code: "111222" });

    // The source yields 111222 first, then 333444.
    let draw = 0;
    const randomBytes = (length: number): Uint8Array => {
      if (length !== 1) return new Uint8Array(length).fill(7);
      const sequence = "111222333444";
      const value = Number(sequence[draw % sequence.length] ?? 0);
      draw += 1;
      return new Uint8Array([value]);
    };

    const code = await t.run(async (ctx) => allocateJoinCode(ctx, { randomBytes }));
    expect(code).toBe("333444");
  });

  it("throws rather than issuing a duplicate when the space is saturated", async () => {
    const taken = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, taken, ownerId, { code: "482913" });

    // A source that only ever produces the one code already in use.
    await expect(
      t.run(async (ctx) => allocateJoinCode(ctx, { randomBytes: bytesFor("482913") })),
    ).rejects.toThrow(CodeGenerationError);
  });

  it("redraws a code that was reissued while the event was archived", async () => {
    const first = await seedEvent(t, ownerId, { state: "archived" });
    const stale = await seedInviteVersion(t, first, ownerId, { code: "482913" });
    // While it was away, somebody else got that number.
    const second = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, second, ownerId, { code: "482913", version: 1 });

    const result = await t.run(async (ctx) => {
      const event = await ctx.db.get(first);
      if (!event) throw new Error("missing");
      await ctx.db.patch(first, { state: "live" });
      const live = await ctx.db.get(first);
      if (!live) throw new Error("missing");
      return await ensureCodeIsFree(ctx, live, {
        now: Date.now(),
        actorUserId: ownerId,
        randomBytes: bytesFor("777888"),
      });
    });

    expect(result?.reissuedCode).toBe("777888");
    expect(result?.version).toBe(2);

    // The historical row is untouched: memberships point at it, and it is the
    // only record of which six digits were on the wall before the re-open.
    const previous = await t.run(async (ctx) => ctx.db.get(stale.inviteVersionId));
    expect(previous?.code).toBe("482913");
    expect(previous?.token).toBe(stale.token);
    expect(previous?.status).toBe("revoked");

    // …and the live credential is a *new* row, with a new token as well as a
    // new code, pointed at by the event.
    const live = await t.run(async (ctx) => {
      const event = await ctx.db.get(first);
      return event?.activeInviteVersionId ? await ctx.db.get(event.activeInviteVersionId) : null;
    });
    expect(live?._id).not.toBe(stale.inviteVersionId);
    expect(live?.code).toBe("777888");
    expect(live?.token).not.toBe(stale.token);
    expect(live?.status).toBe("active");
  });

  it("keeps guests in the party when re-opening forces a new version", async () => {
    const guestId = await seedUser(t, { authId: "reopen-guest", email: "reopen@partybooth.test" });
    const eventId = await seedEvent(t, ownerId, { state: "archived" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    const membershipId = await seedMembership(t, eventId, guestId, "guest");

    const other = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, other, ownerId, { code: "482913", version: 1 });

    await t.run(async (ctx) => {
      await ctx.db.patch(eventId, { state: "live" });
      const live = await ctx.db.get(eventId);
      if (!live) throw new Error("missing");
      await ensureCodeIsFree(ctx, live, {
        now: Date.now(),
        actorUserId: ownerId,
        randomBytes: bytesFor("777888"),
      });
    });

    expect((await t.run(async (ctx) => ctx.db.get(membershipId)))?.status).toBe("active");
  });

  it("leaves the code alone when there is no clash", async () => {
    const eventId = await seedEvent(t, ownerId, { state: "live" });
    const seeded = await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    const result = await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      if (!event) throw new Error("missing");
      return await ensureCodeIsFree(ctx, event, { now: Date.now(), actorUserId: ownerId });
    });
    // `t.run` serialises the return value, so an absent result arrives as null.
    expect(result ?? undefined).toBeUndefined();
    // No clash means no new version — the QR on the wall keeps working.
    const versions = await t.run(async (ctx) => ctx.db.query("inviteVersions").collect());
    expect(versions).toHaveLength(1);
    expect(versions[0]?._id).toBe(seeded.inviteVersionId);
  });
});

/* -------------------------------------------------------------------------- */
/* Minting                                                                    */
/* -------------------------------------------------------------------------- */

describe("mintInviteVersion", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
  });

  it("revokes the outgoing version rather than editing it", async () => {
    const first = await seedInviteVersion(t, eventId, ownerId, { code: "482913" });

    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      if (!event) throw new Error("missing");
      return mintInviteVersion(ctx, {
        event,
        createdByUserId: ownerId,
        now: Date.now(),
        randomBytes: bytesFor("777888"),
      });
    });

    const versions = await t.run(async (ctx) =>
      ctx.db
        .query("inviteVersions")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(versions).toHaveLength(2);
    const old = versions.find((v) => v._id === first.inviteVersionId);
    expect(old?.status).toBe("revoked");
    expect(old?.code).toBe("482913");
    expect(versions.find((v) => v.status === "active")?.version).toBe(2);
  });

  it("keeps guest memberships by default", async () => {
    await seedInviteVersion(t, eventId, ownerId);
    const guestId = await seedUser(t, { authId: "guest", email: "g@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");

    const result = await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      if (!event) throw new Error("missing");
      return mintInviteVersion(ctx, { event, createdByUserId: ownerId, now: Date.now() });
    });

    expect(result.revokedMembershipIds).toHaveLength(0);
  });

  it("revokes guests but never hosts when asked not to keep them", async () => {
    await seedInviteVersion(t, eventId, ownerId);
    const guestId = await seedUser(t, { authId: "guest", email: "g@partybooth.test" });
    const cohostId = await seedUser(t, { authId: "cohost", email: "c@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");
    await seedMembership(t, eventId, cohostId, "cohost");

    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      if (!event) throw new Error("missing");
      return mintInviteVersion(ctx, {
        event,
        createdByUserId: ownerId,
        keepExistingMemberships: false,
        now: Date.now(),
      });
    });

    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(memberships.find((m) => m.userId === guestId)?.status).toBe("revoked");
    // Locking the co-host out mid-party helps nobody.
    expect(memberships.find((m) => m.userId === cohostId)?.status).toBe("active");
    expect(memberships.find((m) => m.userId === ownerId)?.status).toBe("active");
  });

  it("audits every membership it revokes, one row per person", async () => {
    await seedInviteVersion(t, eventId, ownerId);
    const guestId = await seedUser(t, { authId: "guest", email: "g@partybooth.test" });
    const otherId = await seedUser(t, { authId: "other", email: "o@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");
    await seedMembership(t, eventId, otherId, "guest");

    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      if (!event) throw new Error("missing");
      return mintInviteVersion(ctx, {
        event,
        createdByUserId: ownerId,
        keepExistingMemberships: false,
        now: Date.now(),
      });
    });

    const revoked = (await auditRows(t)).filter(
      (row) => row.action === AUDIT_ACTIONS.membershipRevoked,
    );
    expect(revoked).toHaveLength(2);
    // `membership.revoked` is on AUDIT_ACTIONS_REQUIRING_REASON, and the bulk
    // path has to supply one rather than skipping the row.
    expect(revoked.every((row) => (row.reason ?? "").length > 0)).toBe(true);
    expect(revoked.map((row) => row.metadata?.["revokedUserId"]).sort()).toEqual(
      [guestId, otherId].sort(),
    );
    expect(revoked.every((row) => row.metadata?.["via"] === "inviteRotation")).toBe(true);
  });

  it("never redraws the code it is replacing", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });

    // A randomness source that only ever produces the outgoing code. Before,
    // `ignoreEventId` excused this event's own version from the collision
    // check and the draw handed the same six digits straight back.
    await expect(
      t.run(async (ctx) => {
        const event = await ctx.db.get(eventId);
        if (!event) throw new Error("missing");
        return mintInviteVersion(ctx, {
          event,
          createdByUserId: ownerId,
          now: Date.now(),
          randomBytes: bytesFor("482913"),
        });
      }),
    ).rejects.toThrow(CodeGenerationError);
  });

  it("refuses a specific code identical to the outgoing one", async () => {
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    await expect(
      t.run(async (ctx) => {
        const event = await ctx.db.get(eventId);
        if (!event) throw new Error("missing");
        return mintInviteVersion(ctx, {
          event,
          createdByUserId: ownerId,
          specificCode: "482913",
          now: Date.now(),
        });
      }),
    ).rejects.toThrow(/must change the code/i);
  });

  it("draws a fresh code for a draft event too", async () => {
    // Draft events are not joinable, so their code is "free" by the uniqueness
    // rule — which used to mean a rotation could legitimately redraw it.
    const draftId = await seedEvent(t, ownerId, { state: "draft", name: "Draft" });
    await seedInviteVersion(t, draftId, ownerId, { code: "482913" });

    await expect(
      t.run(async (ctx) => {
        const event = await ctx.db.get(draftId);
        if (!event) throw new Error("missing");
        return mintInviteVersion(ctx, {
          event,
          createdByUserId: ownerId,
          now: Date.now(),
          randomBytes: bytesFor("482913"),
        });
      }),
    ).rejects.toThrow(CodeGenerationError);
  });
});

/* -------------------------------------------------------------------------- */
/* The rotate mutation                                                        */
/* -------------------------------------------------------------------------- */

describe("invites.rotate", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  it("mints the next version and audits it with a reason", async () => {
    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.invites.rotate, { eventId });

    expect(result.version).toBe(2);
    expect(result.code).not.toBe("482913");

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.inviteRotated);
    // `event.invite_rotated` is on AUDIT_ACTIONS_REQUIRING_REASON.
    expect(row?.reason).toBeTruthy();
    expect(row?.metadata).toMatchObject({ version: 2, previousVersion: 1 });
    // The code itself never goes in an audit row.
    expect(JSON.stringify(row)).not.toContain("482913");
  });

  it("lets a co-host rotate — it is the party-night emergency lever", async () => {
    const cohostId = await seedUser(t, { authId: "cohost", email: "c@partybooth.test" });
    await seedMembership(t, eventId, cohostId, "cohost");
    const as = t.withIdentity({ subject: "cohost" });
    await expect(as.mutation(api.invites.rotate, { eventId })).resolves.toMatchObject({
      version: 2,
    });
  });

  it("refuses a guest", async () => {
    const guestId = await seedUser(t, { authId: "guest", email: "g@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");
    const as = t.withIdentity({ subject: "guest" });
    await expect(as.mutation(api.invites.rotate, { eventId })).rejects.toThrow(/permission/i);
  });

  it("refuses a specific code from a host", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await expect(
      as.mutation(api.invites.rotate, { eventId, specificCode: "573926" }),
    ).rejects.toThrow(/admin console/i);
  });

  it("accepts a specific code from an admin, and refuses a guessable one", async () => {
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "admin" });

    await expect(
      as.mutation(api.invites.rotate, { eventId, specificCode: "123456", reason: "support" }),
    ).rejects.toThrow(/guess/i);

    const result = await as.mutation(api.invites.rotate, {
      eventId,
      specificCode: "573926",
      reason: "Poster reprinted",
    });
    expect(result.code).toBe("573926");
  });

  it("refuses an admin rotating to the code it is rotating away from", async () => {
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "admin" });
    await expect(
      as.mutation(api.invites.rotate, { eventId, specificCode: "482913", reason: "typo" }),
    ).rejects.toThrow(/rotating away from/i);

    // Nothing happened: the version is still 1 and still active.
    const versions = await t.run(async (ctx) => ctx.db.query("inviteVersions").collect());
    expect(versions).toHaveLength(1);
    expect(versions[0]?.status).toBe("active");
  });

  it("refuses a specific code already in use elsewhere", async () => {
    const other = await seedEvent(t, ownerId, { state: "live", name: "Other" });
    await seedInviteVersion(t, other, ownerId, { code: "573926" });
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "admin" });
    await expect(
      as.mutation(api.invites.rotate, { eventId, specificCode: "573926", reason: "x" }),
    ).rejects.toThrow(/already in use/i);
  });
});

describe("invites.current", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
  });

  it("gives a host the current code and token", async () => {
    const as = t.withIdentity({ subject: "owner" });
    expect((await as.query(api.invites.current, { eventId }))?.code).toBe("482913");
  });

  it("refuses a guest", async () => {
    const guestId = await seedUser(t, { authId: "guest", email: "g@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");
    const as = t.withIdentity({ subject: "guest" });
    await expect(as.query(api.invites.current, { eventId })).rejects.toThrow(/permission/i);
  });
});
