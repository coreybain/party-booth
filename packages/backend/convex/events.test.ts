import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  ADMIN_EMAIL,
  api,
  auditActions,
  auditRows,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMembership,
  seedUser,
  setAllowlist,
  type T,
} from "./testing.helpers";

const HOUR = 60 * 60 * 1000;

function scheduleFrom(now: number) {
  return { startsAt: now + HOUR, endsAt: now + 6 * HOUR, timeZone: "Europe/London" };
}

afterEach(() => {
  setAllowlist(undefined);
  vi.restoreAllMocks();
});

describe("events.create", () => {
  let t: T;

  beforeEach(() => {
    t = makeTest();
  });

  it("refuses an account with no organiser invitation", async () => {
    await seedUser(t, { authId: "a1", email: "nobody@partybooth.test", isOrganiser: false });
    const as = t.withIdentity({ subject: "a1" });
    await expect(
      as.mutation(api.events.create, { name: "Party", schedule: scheduleFrom(Date.now()) }),
    ).rejects.toThrow(/invitation-only/i);
  });

  it("lets a global admin create an event without an organiser invitation", async () => {
    setAllowlist(ADMIN_EMAIL);
    const adminId = await seedUser(t, {
      authId: "admin",
      email: ADMIN_EMAIL,
      isOrganiser: false,
      isGlobalAdmin: false,
    });

    const created = await t.withIdentity({ subject: "admin" }).mutation(api.events.create, {
      name: "Admin party",
      schedule: scheduleFrom(Date.now()),
    });

    const event = await t.run(async (ctx) => ctx.db.get(created.eventId));
    expect(event?.ownerUserId).toBe(adminId);

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) =>
          q.eq("eventId", created.eventId).eq("userId", adminId),
        )
        .unique(),
    );
    expect(membership?.role).toBe("owner");
  });

  it("creates an event, its owner membership and its first invite version", async () => {
    const ownerId = await seedUser(t, { authId: "a1", email: "owner@partybooth.test" });
    const as = t.withIdentity({ subject: "a1" });

    const created = await as.mutation(api.events.create, {
      name: "  Summer party  ",
      schedule: scheduleFrom(Date.now()),
      moderationMode: "automatic",
      accentColor: "#AABBCC",
      allowLibraryImport: false,
    });

    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);

    const event = await t.run(async (ctx) => ctx.db.get(created.eventId));
    expect(event?.name).toBe("Summer party"); // trimmed by the contract schema
    expect(event?.accentColor).toBe("#aabbcc"); // and lower-cased
    expect(event?.state).toBe("scheduled");
    expect(event?.moderationMode).toBe("automatic");
    expect(event?.allowLibraryImport).toBe(false);
    expect(event?.publicGalleryEnabled).toBe(false);
    expect(event?.activeInviteVersionId).toBe(created.inviteVersionId);

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) =>
          q.eq("eventId", created.eventId).eq("userId", ownerId),
        )
        .unique(),
    );
    expect(membership?.role).toBe("owner");
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.eventCreated);
  });

  it("can be created as a draft, so the code is not live yet", async () => {
    await seedUser(t, { authId: "a1", email: "owner@partybooth.test" });
    const as = t.withIdentity({ subject: "a1" });
    const created = await as.mutation(api.events.create, {
      name: "Not yet",
      schedule: scheduleFrom(Date.now()),
      initialState: "draft",
    });
    const event = await t.run(async (ctx) => ctx.db.get(created.eventId));
    expect(event?.state).toBe("draft");
  });

  it("applies the contract's validation, not the client's", async () => {
    await seedUser(t, { authId: "a1", email: "owner@partybooth.test" });
    const as = t.withIdentity({ subject: "a1" });
    const now = Date.now();

    await expect(
      as.mutation(api.events.create, { name: "   ", schedule: scheduleFrom(now) }),
    ).rejects.toThrow(/name/i);

    await expect(
      as.mutation(api.events.create, {
        name: "Backwards",
        schedule: { startsAt: now + HOUR, endsAt: now, timeZone: "Europe/London" },
      }),
    ).rejects.toThrow(/end time/i);

    await expect(
      as.mutation(api.events.create, {
        name: "Bad colour",
        schedule: scheduleFrom(now),
        accentColor: "red",
      }),
    ).rejects.toThrow(/colour/i);
  });

  it("points the creator's active event at their first party", async () => {
    const ownerId = await seedUser(t, { authId: "a1", email: "owner@partybooth.test" });
    const as = t.withIdentity({ subject: "a1" });
    const created = await as.mutation(api.events.create, {
      name: "First",
      schedule: scheduleFrom(Date.now()),
    });
    const user = await t.run(async (ctx) => ctx.db.get(ownerId));
    expect(user?.activeEventId).toBe(created.eventId);
  });

  it("refuses a locked account", async () => {
    await seedUser(t, {
      authId: "a1",
      email: "owner@partybooth.test",
      accountState: "locked",
    });
    const as = t.withIdentity({ subject: "a1" });
    await expect(
      as.mutation(api.events.create, { name: "Party", schedule: scheduleFrom(Date.now()) }),
    ).rejects.toThrow(/suspended/i);
  });
});

describe("events.setPublicGallery", () => {
  it("lets the owner publish and close an archived gallery, with an audit trail", async () => {
    const t = makeTest();
    const ownerId = await seedUser(t, {
      authId: "owner",
      email: "owner@partybooth.test",
    });
    const eventId = await seedEvent(t, ownerId, { state: "archived" });
    const asOwner = t.withIdentity({ subject: "owner" });

    await expect(
      asOwner.mutation(api.events.setPublicGallery, { eventId, enabled: true }),
    ).resolves.toEqual({ enabled: true });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.publicGalleryEnabled).toBe(true);

    await asOwner.mutation(api.events.setPublicGallery, { eventId, enabled: false });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.publicGalleryEnabled).toBe(false);

    const updates = (await auditRows(t)).filter((row) => row.action === AUDIT_ACTIONS.eventUpdated);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.metadata).toEqual({ fields: ["publicGalleryEnabled"] });
  });

  it("keeps the public decision with the owner", async () => {
    const t = makeTest();
    const ownerId = await seedUser(t, {
      authId: "owner",
      email: "owner@partybooth.test",
    });
    const cohostId = await seedUser(t, {
      authId: "cohost",
      email: "cohost@partybooth.test",
    });
    const eventId = await seedEvent(t, ownerId, { state: "archived" });
    await seedMembership(t, eventId, cohostId, "cohost");

    await expect(
      t
        .withIdentity({ subject: "cohost" })
        .mutation(api.events.setPublicGallery, { eventId, enabled: true }),
    ).rejects.toThrow(/permission/i);
  });
});

describe("events.update — permission isolation", () => {
  let t: T;
  let ownerId: Id<"users">;
  let cohostId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, cohostId, "cohost");
    await seedMembership(t, eventId, guestId, "guest");
  });

  it("lets the owner rename the party", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await as.mutation(api.events.update, { eventId, name: "Renamed" });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.name).toBe("Renamed");
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.eventUpdated);
  });

  it("refuses a guest editing the event", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await expect(as.mutation(api.events.update, { eventId, name: "Mine now" })).rejects.toThrow(
      /permission/i,
    );
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.name).toBe("Test party");
  });

  it("lets a co-host rename the party and change the moderation mode", async () => {
    /*
     * This reversed in Sprint 5, deliberately, and the reason is PLAN.md risk
     * #4: solo moderation is mitigated by "co-hosts and `automatic` mode as a
     * pressure valve", and a co-host who cannot reach the moderation-mode switch
     * when the owner is on the dance floor is not a pressure valve. What a
     * co-host still cannot do is change *who owns* the party — see the co-host
     * matrix in `permissions.test.ts` and the tests below.
     */
    const as = t.withIdentity({ subject: "cohost" });
    await as.mutation(api.events.update, { eventId, name: "Ours" });
    await as.mutation(api.events.update, { eventId, moderationMode: "automatic" });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.name).toBe("Ours");
    expect(event?.moderationMode).toBe("automatic");
  });

  it("lets a co-host move the schedule", async () => {
    const as = t.withIdentity({ subject: "cohost" });
    const now = Date.now();
    await as.mutation(api.events.update, {
      eventId,
      schedule: { startsAt: now + HOUR, timeZone: "Europe/London" },
    });
    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.startsAt).toBe(now + HOUR);
    expect(event?.endsAt).toBeUndefined();
  });

  it("hides the event from a stranger behind notFound", async () => {
    await seedUser(t, { authId: "stranger", email: "who@partybooth.test" });
    const as = t.withIdentity({ subject: "stranger" });
    await expect(as.mutation(api.events.update, { eventId, name: "x" })).rejects.toThrow(
      /could not be found/i,
    );
  });

  it("records field names in the audit row, never values", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await as.mutation(api.events.update, { eventId, name: "Secret venue" });
    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.eventUpdated);
    expect(row?.metadata).toEqual({ fields: ["name"] });
    expect(JSON.stringify(row)).not.toContain("Secret venue");
  });

  it("is a no-op when nothing was sent", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await as.mutation(api.events.update, { eventId });
    expect(await auditActions(t)).not.toContain(AUDIT_ACTIONS.eventUpdated);
  });

  it("refuses edits once the event is archived", async () => {
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "archived" }));
    const as = t.withIdentity({ subject: "owner" });
    await expect(as.mutation(api.events.update, { eventId, name: "Nope" })).rejects.toThrow(
      /not available/i,
    );
  });
});

describe("events.setState", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "scheduled" });
  });

  it.each([
    ["scheduled", "live"],
    ["live", "paused"],
    ["paused", "live"],
    ["live", "archived"],
    ["archived", "live"],
  ] as const)("allows %s → %s", async (from, to) => {
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: from }));
    const as = t.withIdentity({ subject: "owner" });
    await expect(as.mutation(api.events.setState, { eventId, state: to })).resolves.toMatchObject({
      state: to,
    });
  });

  it.each([
    ["archived", "paused"],
    ["archived", "scheduled"],
    ["live", "draft"],
    ["live", "scheduled"],
  ] as const)("refuses %s → %s", async (from, to) => {
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: from }));
    const as = t.withIdentity({ subject: "owner" });
    await expect(as.mutation(api.events.setState, { eventId, state: to })).rejects.toThrow(
      /cannot move/i,
    );
  });

  it("treats a repeat of the current state as a no-op, not an error", async () => {
    // Mutations retry and hosts double-tap.
    const as = t.withIdentity({ subject: "owner" });
    await expect(
      as.mutation(api.events.setState, { eventId, state: "scheduled" }),
    ).resolves.toEqual({ state: "scheduled" });
    expect(await auditActions(t)).not.toContain(AUDIT_ACTIONS.eventStateChanged);
  });

  it("stamps archivedAt and audits the move", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await as.mutation(api.events.setState, { eventId, state: "archived" });
    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.archivedAt).toBeGreaterThan(0);

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.eventStateChanged);
    expect(row?.metadata).toMatchObject({ from: "scheduled", to: "archived" });
    expect(row?.actorRole).toBe("owner");
  });

  it("mints a new invite version when re-opening finds its code reused", async () => {
    // The after-party path: archive, somebody else is handed those six digits,
    // then the host re-opens. The old `inviteVersions` row is the credential
    // every membership admitted under it points at, so it must come out of this
    // byte-for-byte identical — a patch would rewrite history.
    const stale = await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "archived" }));

    const other = await seedEvent(t, ownerId, { state: "live", name: "Someone else" });
    await seedInviteVersion(t, other, ownerId, { code: "482913", version: 1 });

    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.events.setState, { eventId, state: "live" });

    expect(result.reissuedCode).toBeDefined();
    expect(result.reissuedCode).not.toBe("482913");

    const previous = await t.run(async (ctx) => ctx.db.get(stale.inviteVersionId));
    expect(previous?.code).toBe("482913");
    expect(previous?.token).toBe(stale.token);
    expect(previous?.version).toBe(1);
    // Retired, not rewritten.
    expect(previous?.status).toBe("revoked");

    const versions = await t.run(async (ctx) =>
      ctx.db
        .query("inviteVersions")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(versions).toHaveLength(2);
    const active = versions.find((version) => version.status === "active");
    expect(active?.version).toBe(2);
    expect(active?.code).toBe(result.reissuedCode);
    expect(active?.token).not.toBe(stale.token);

    const row = (await auditRows(t)).find((r) => r.action === AUDIT_ACTIONS.eventStateChanged);
    expect(row?.metadata).toMatchObject({ codeReissued: true, inviteVersion: 2 });
    expect(JSON.stringify(row)).not.toContain("482913");
  });

  it("leaves the invite version alone when re-opening finds no clash", async () => {
    const stale = await seedInviteVersion(t, eventId, ownerId, { code: "482913" });
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "archived" }));

    const as = t.withIdentity({ subject: "owner" });
    const result = await as.mutation(api.events.setState, { eventId, state: "live" });

    expect(result.reissuedCode).toBeUndefined();
    const versions = await t.run(async (ctx) => ctx.db.query("inviteVersions").collect());
    expect(versions).toHaveLength(1);
    expect(versions[0]?._id).toBe(stale.inviteVersionId);
    expect(versions[0]?.status).toBe("active");
  });

  it("lets a co-host pause and resume, and refuses them archiving", async () => {
    /*
     * The Sprint 5 split. Moving between `live` and `paused` is running the
     * party, which is what a co-host is for; `archived` ends it, which is the
     * owner's call. `event.archive` existed in the matrix from Sprint 1 and was
     * read by nothing until `setState` started demanding it for this one
     * destination.
     */
    const cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    await seedMembership(t, eventId, cohostId, "cohost");
    const as = t.withIdentity({ subject: "cohost" });

    await as.mutation(api.events.setState, { eventId, state: "live" });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.state).toBe("live");

    await as.mutation(api.events.setState, { eventId, state: "paused" });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.state).toBe("paused");

    await expect(as.mutation(api.events.setState, { eventId, state: "archived" })).rejects.toThrow(
      /permission/i,
    );
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.state).toBe("paused");
  });

  it("does not offer deletionScheduled at all", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await expect(
      // @ts-expect-error — the argument validator excludes it, which is the point.
      as.mutation(api.events.setState, { eventId, state: "deletionScheduled" }),
    ).rejects.toThrow();
  });
});

describe("events.setNow", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "scheduled" });
  });

  it("starts now by stamping the server time and activating the event", async () => {
    const now = Date.now() + HOUR;
    const plannedEnd = now + 4 * HOUR;
    await t.run(async (ctx) => ctx.db.patch(eventId, { startsAt: now + HOUR, endsAt: plannedEnd }));
    vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(
      t.withIdentity({ subject: "owner" }).mutation(api.events.setNow, {
        eventId,
        action: "start",
      }),
    ).resolves.toEqual({ state: "live" });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ state: "live", startsAt: now, endsAt: plannedEnd });

    const rows = await auditRows(t);
    expect(rows.find((row) => row.action === AUDIT_ACTIONS.eventUpdated)?.metadata).toEqual({
      fields: ["schedule"],
    });
    expect(
      rows.find((row) => row.action === AUDIT_ACTIONS.eventStateChanged)?.metadata,
    ).toMatchObject({ from: "scheduled", to: "live" });
  });

  it("starts a future-published live event now by moving its start boundary", async () => {
    const now = Date.now() + HOUR;
    const plannedEnd = now + 4 * HOUR;
    await t.run(async (ctx) =>
      ctx.db.patch(eventId, {
        state: "live",
        startsAt: now + HOUR,
        endsAt: plannedEnd,
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(
      t.withIdentity({ subject: "owner" }).mutation(api.events.setNow, {
        eventId,
        action: "start",
      }),
    ).resolves.toEqual({ state: "live" });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ state: "live", startsAt: now, endsAt: plannedEnd });

    const rows = await auditRows(t);
    expect(rows.find((row) => row.action === AUDIT_ACTIONS.eventUpdated)?.metadata).toEqual({
      fields: ["schedule"],
    });
    expect(rows.some((row) => row.action === AUDIT_ACTIONS.eventStateChanged)).toBe(false);
  });

  it("clears an expired end time when restarting a paused event", async () => {
    const now = Date.now() + HOUR;
    await t.run(async (ctx) =>
      ctx.db.patch(eventId, {
        state: "paused",
        startsAt: now - 2 * HOUR,
        endsAt: now - HOUR,
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(now);

    await t.withIdentity({ subject: "owner" }).mutation(api.events.setNow, {
      eventId,
      action: "start",
    });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.state).toBe("live");
    expect(event?.startsAt).toBe(now);
    expect(event?.endsAt).toBeUndefined();
  });

  it("ends now by stamping the server time and deactivating the event", async () => {
    const now = Date.now() + HOUR;
    const originalStart = now - 2 * HOUR;
    await t.run(async (ctx) =>
      ctx.db.patch(eventId, {
        state: "live",
        startsAt: originalStart,
        endsAt: now + HOUR,
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(
      t.withIdentity({ subject: "owner" }).mutation(api.events.setNow, {
        eventId,
        action: "end",
      }),
    ).resolves.toEqual({ state: "paused" });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ state: "paused", startsAt: originalStart, endsAt: now });
  });

  it("keeps the schedule valid when ending a future-published event", async () => {
    const now = Date.now() + HOUR;
    await t.run(async (ctx) =>
      ctx.db.patch(eventId, {
        state: "live",
        startsAt: now + HOUR,
        endsAt: now + 2 * HOUR,
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(now);

    await t.withIdentity({ subject: "owner" }).mutation(api.events.setNow, {
      eventId,
      action: "end",
    });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ state: "paused", startsAt: now - 1, endsAt: now });
  });

  it("lets a co-host start and end the event now", async () => {
    const cohostId = await seedUser(t, {
      authId: "cohost",
      email: "cohost@partybooth.test",
    });
    await seedMembership(t, eventId, cohostId, "cohost");
    const asCohost = t.withIdentity({ subject: "cohost" });

    await asCohost.mutation(api.events.setNow, { eventId, action: "start" });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.state).toBe("live");

    await asCohost.mutation(api.events.setNow, { eventId, action: "end" });
    expect((await t.run(async (ctx) => ctx.db.get(eventId)))?.state).toBe("paused");
  });
});

describe("events.leave", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live", name: "Main party" });
    await seedMembership(t, eventId, guestId, "guest");
  });

  it("marks the membership left, takes the party off the list, and audits it", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.events.leave, { eventId });

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", guestId))
        .unique(),
    );
    expect(membership?.status).toBe("left");
    expect(await as.query(api.events.myEvents, {})).toEqual([]);
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.membershipLeft);
  });

  it("clears the active-event pointer when it pointed at the left party", async () => {
    await t.run(async (ctx) => ctx.db.patch(guestId, { activeEventId: eventId }));
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.events.leave, { eventId });
    expect((await t.run(async (ctx) => ctx.db.get(guestId)))?.activeEventId).toBeUndefined();
  });

  it("leaves the active-event pointer alone when it pointed elsewhere", async () => {
    const other = await seedEvent(t, ownerId, { name: "Other" });
    await seedMembership(t, other, guestId, "guest");
    await t.run(async (ctx) => ctx.db.patch(guestId, { activeEventId: other }));
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.events.leave, { eventId });
    expect((await t.run(async (ctx) => ctx.db.get(guestId)))?.activeEventId).toBe(other);
  });

  it("refuses the owner, whose exit is deletion", async () => {
    const as = t.withIdentity({ subject: "owner" });
    await expect(as.mutation(api.events.leave, { eventId })).rejects.toThrow(/host/i);
    const list = await as.query(api.events.myEvents, {});
    expect(list.map((entry) => entry.id)).toEqual([eventId]);
  });

  it("answers a stranger with not-found, exactly like a read would", async () => {
    await seedUser(t, { authId: "stranger", email: "s@partybooth.test" });
    const as = t.withIdentity({ subject: "stranger" });
    await expect(as.mutation(api.events.leave, { eventId })).rejects.toThrow(/could not be found/i);
  });

  it("lets the same person walk back in through the join door", async () => {
    // Leaving must stay reversible by the same credential that admitted them —
    // `join.ts` re-activates a `left` row rather than refusing it.
    const { code } = await seedInviteVersion(t, eventId, ownerId, { makeActive: true });
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.events.leave, { eventId });
    const outcome = await as.mutation(api.join.join, { invite: { via: "code", code } });
    expect(outcome.outcome).toBe("joined");
    expect((await as.query(api.events.myEvents, {})).map((entry) => entry.id)).toEqual([eventId]);
  });
});

describe("events.myEvents / activeEvent / home", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live", name: "Main party" });
    await seedMembership(t, eventId, guestId, "guest");
  });

  it("lists hosted and attended events through one code path", async () => {
    const asOwner = t.withIdentity({ subject: "owner" });
    const asGuest = t.withIdentity({ subject: "guest" });
    expect((await asOwner.query(api.events.myEvents, {}))[0]?.role).toBe("owner");
    expect((await asGuest.query(api.events.myEvents, {}))[0]?.role).toBe("guest");
  });

  it("leaves out an event that is scheduled for deletion", async () => {
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "deletionScheduled" }));
    const as = t.withIdentity({ subject: "guest" });
    expect(await as.query(api.events.myEvents, {})).toEqual([]);
  });

  it("orders newest party first", async () => {
    const later = await seedEvent(t, ownerId, { startsAt: Date.now() + 10 * HOUR, name: "Later" });
    const as = t.withIdentity({ subject: "owner" });
    const list = await as.query(api.events.myEvents, {});
    expect(list.map((e) => e.id)).toEqual([later, eventId]);
  });

  it("falls back to the most recent membership when nothing is selected", async () => {
    const as = t.withIdentity({ subject: "guest" });
    expect((await as.query(api.events.activeEvent, {}))?.id).toBe(eventId);
  });

  it("ignores a stale selection instead of getting stuck on it", async () => {
    const other = await seedEvent(t, ownerId, { name: "Other" });
    await seedMembership(t, other, guestId, "guest");
    // Point them at an event whose membership has since been revoked.
    await t.run(async (ctx) => {
      await ctx.db.patch(guestId, { activeEventId: eventId });
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", guestId))
        .unique();
      if (membership) await ctx.db.patch(membership._id, { status: "revoked" });
    });
    const as = t.withIdentity({ subject: "guest" });
    expect((await as.query(api.events.activeEvent, {}))?.id).toBe(other);
  });

  it("refuses to point at an event the user is not in", async () => {
    const strangerEvent = await seedEvent(t, ownerId, { name: "Not yours" });
    await seedUser(t, { authId: "stranger", email: "s@partybooth.test" });
    const as = t.withIdentity({ subject: "stranger" });
    await expect(
      as.mutation(api.events.setActiveEvent, { eventId: strangerEvent }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("clears the selection with null", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.events.setActiveEvent, { eventId: null });
    expect((await t.run(async (ctx) => ctx.db.get(guestId)))?.activeEventId).toBeUndefined();
  });

  it("gives hosts the code and withholds it from guests", async () => {
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("inviteVersions", {
        eventId,
        version: 1,
        code: "482913",
        token: "ABCDEFGHJKMNPQRSTVWXYZ0123456789",
        status: "active",
        createdByUserId: ownerId,
        createdAt: Date.now(),
      });
      await ctx.db.patch(eventId, { activeInviteVersionId: id });
    });

    const asOwner = t.withIdentity({ subject: "owner" });
    const owner = await asOwner.query(api.events.home, { eventId });
    expect(owner.isHost).toBe(true);
    expect(owner.invite?.code).toBe("482913");
    expect(owner.memberCount).toBe(2);

    const asGuest = t.withIdentity({ subject: "guest" });
    const guest = await asGuest.query(api.events.home, { eventId });
    expect(guest.isHost).toBe(false);
    // Withheld from the payload, not merely hidden in the UI — a guest with the
    // code can re-share the party to anyone.
    expect(guest.invite).toBeUndefined();
    expect(JSON.stringify(guest)).not.toContain("482913");
  });

  it("does not give an admin host powers, only the code they may rotate", async () => {
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "admin" });
    const home = await as.query(api.events.home, { eventId });
    expect(home.isHost).toBe(false);
    expect(home.event.role).toBe("guest");
  });
});
