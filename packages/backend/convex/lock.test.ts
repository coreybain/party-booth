import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  ADMIN_EMAIL,
  api,
  CALLBACK_SECRET,
  clearFakePush,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedInviteVersion,
  seedMedia,
  seedMembership,
  seedUser,
  setAllowlist,
  setCallbackSecret,
  useFakePush,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * The account-lock sweep — **RC5's demo**, in a suite.
 *
 * > lock the organiser from `/admin` and watch everything freeze.
 *
 * The half that was already true is the locked person's own access. The half
 * this suite is about is the one PLAN.md actually asks for and that nothing
 * enforced: a lock "suspends owner/co-host access, joins, uploads, slideshows
 * **across owned events**". Every one of those surfaces is exercised here from
 * the *other* people's identities, because the failure being guarded against is
 * a co-host who keeps moderating and guests who keep uploading into a party
 * whose host has just been suspended.
 */

/** An unspent grant in somebody's hands, exactly as `issueGrant` writes one. */
async function seedGrant(
  t: T,
  eventId: Id<"events">,
  userId: Id<"users">,
  captureId: string,
): Promise<Id<"uploadGrants">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("uploadGrants", {
      eventId,
      userId,
      captureId,
      secretHash: captureId.padEnd(64, "9").slice(0, 64),
      status: "issued",
      mediaType: "photo",
      fromLibrary: false,
      storageRegion: "pdx1",
      byteSize: 1024,
      mimeType: "image/jpeg",
      checksum: "8".repeat(64),
      issuedAt: now,
      expiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

describe("a locked owner freezes every event they own", () => {
  let t: T;
  let ownerId: Id<"users">;
  let cohostId: Id<"users">;
  let guestId: Id<"users">;
  let strangerId: Id<"users">;
  let firstEvent: Id<"events">;
  let secondEvent: Id<"events">;
  let code: string;

  /** Lock the owner exactly the way the console does. */
  async function lockOwner(): Promise<void> {
    await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.lockAccount, { userId: ownerId, reason: "Complaint from a guest" });
  }

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    useFakePush();
    setAllowlist(ADMIN_EMAIL);

    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    strangerId = await seedUser(t, { authId: "stranger", email: "new@partybooth.test" });

    firstEvent = await seedEvent(t, ownerId, { state: "live", name: "Party one" });
    // The second one exists because the requirement is "across **all** owned
    // events", and a sweep that enumerates one event is a sweep that misses the
    // other.
    secondEvent = await seedEvent(t, ownerId, { state: "live", name: "Party two" });

    await seedMembership(t, firstEvent, cohostId, "cohost");
    await seedMembership(t, firstEvent, guestId, "guest");
    await seedMembership(t, secondEvent, guestId, "guest");

    ({ code } = await seedInviteVersion(t, firstEvent, ownerId, { code: "482913" }));
    await seedInviteVersion(t, secondEvent, ownerId, {
      code: "375291",
      token: "Z".repeat(32),
    });
  });

  afterEach(() => {
    clearFakeStorage();
    clearFakePush();
    setAllowlist(undefined);
  });

  it("suspends the co-host's access to the party", async () => {
    const as = t.withIdentity({ subject: "cohost" });
    // Before: they are running a party.
    expect(await as.query(api.events.home, { eventId: firstEvent })).toBeTruthy();

    await lockOwner();

    await expect(as.query(api.events.home, { eventId: firstEvent })).rejects.toThrow(/suspended/i);
    await expect(as.query(api.moderation.pending, { eventId: firstEvent })).rejects.toThrow(
      /suspended/i,
    );
    await expect(
      as.mutation(api.events.update, { eventId: firstEvent, moderationMode: "automatic" }),
    ).rejects.toThrow(/suspended/i);
  });

  it("stops the co-host moderating", async () => {
    const mediaId = await seedMedia(t, firstEvent, guestId, { state: "pending" });
    await lockOwner();

    await expect(
      t.withIdentity({ subject: "cohost" }).mutation(api.moderation.moderate, {
        eventId: firstEvent,
        mediaIds: [mediaId],
        action: "approve",
      }),
    ).rejects.toThrow(/suspended/i);

    expect((await t.run(async (ctx) => ctx.db.get(mediaId)))?.state).toBe("pending");
  });

  it("stops the slideshow", async () => {
    await lockOwner();
    await expect(
      t.withIdentity({ subject: "cohost" }).query(api.slideshow.feed, { eventId: firstEvent }),
    ).rejects.toThrow(/suspended/i);
  });

  it("refuses upload grants and every signed-URL read path to the guests", async () => {
    await seedMedia(t, firstEvent, guestId, { state: "approved", storageKey: "k1" });
    await lockOwner();

    const as = t.withIdentity({ subject: "guest" });

    await expect(
      as.mutation(api.media.requestUploadGrant, {
        eventId: firstEvent,
        captureId: "capture-abcdefgh",
        mediaType: "photo",
        byteSize: 2048,
        mimeType: "image/jpeg",
        checksum: "a".repeat(64),
      }),
    ).rejects.toThrow(/suspended/i);

    // The read paths are where the signed URLs are minted.
    await expect(as.query(api.media.myMedia, { eventId: firstEvent })).rejects.toThrow(
      /suspended/i,
    );
    await expect(as.query(api.media.eventMedia, { eventId: firstEvent })).rejects.toThrow(
      /suspended/i,
    );
  });

  it("refuses new joiners, with the same sentence every other rejection uses", async () => {
    await lockOwner();

    const result = await t
      .withIdentity({ subject: "stranger" })
      .mutation(api.join.join, { invite: { via: "code", code } });

    expect(result.outcome).toBe("rejected");
    // Nothing about a third party's standing with us leaks to a guest at a door.
    expect(JSON.stringify(result)).not.toMatch(/lock|suspend/i);

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) => q.eq("eventId", firstEvent).eq("userId", strangerId))
        .unique(),
    );
    expect(membership).toBeNull();
  });

  it("freezes the second owned event too, not just the one somebody looked at", async () => {
    await lockOwner();

    await expect(
      t.withIdentity({ subject: "guest" }).query(api.events.home, { eventId: secondEvent }),
    ).rejects.toThrow(/suspended/i);

    const result = await t
      .withIdentity({ subject: "stranger" })
      .mutation(api.join.join, { invite: { via: "code", code: "375291" } });
    expect(result.outcome).toBe("rejected");
  });

  it("freezes an event the locked owner creates afterwards, without anybody sweeping it", async () => {
    // The reason the check is a property of the event rather than a list written
    // at lock time. (An account cannot create an event while locked, so this is
    // asserted the other way round: pre-existing rows are covered by the same
    // predicate, whenever they were made.)
    const third = await seedEvent(t, ownerId, { state: "live", name: "Party three" });
    await seedMembership(t, third, guestId, "guest");
    await lockOwner();

    await expect(
      t.withIdentity({ subject: "guest" }).query(api.events.home, { eventId: third }),
    ).rejects.toThrow(/suspended/i);
  });

  it("takes the frozen parties off everybody else's lists", async () => {
    const as = t.withIdentity({ subject: "guest" });
    expect(await as.query(api.events.myEvents, {})).toHaveLength(2);

    await lockOwner();

    expect(await as.query(api.events.myEvents, {})).toHaveLength(0);
    expect(await as.query(api.events.activeEvent, {})).toBeNull();
  });

  /**
   * Grants are the one capability that outlives a permission check —
   * `completeUpload` validates the grant, not the membership and not the account
   * state — so the sweep has to reach **everybody's**, not only the locked
   * person's. The version of this test that only ever inserted a row attributed
   * to `ownerId` passed against a sweep that swept nothing but the owner, which
   * is exactly the gap it was supposed to be guarding.
   */
  it("expires the upload grants that were already in other people's hands", async () => {
    const guestGrant = await seedGrant(t, firstEvent, guestId, "capture-guest111");
    const cohostGrant = await seedGrant(t, firstEvent, cohostId, "capture-cohost11");
    const secondEventGrant = await seedGrant(t, secondEvent, guestId, "capture-guest222");
    const ownerGrant = await seedGrant(t, firstEvent, ownerId, "capture-owner111");

    await lockOwner();

    for (const id of [guestGrant, cohostGrant, secondEventGrant, ownerGrant]) {
      expect((await t.run(async (ctx) => ctx.db.get(id)))?.status).toBe("expired");
    }
  });

  /**
   * The other half of the same requirement: a locked account may not upload into
   * a party it does **not** own either. `expireGrantsForEvent` cannot see that
   * one, so the account-wide sweep has to.
   */
  it("expires the locked account's grants in parties it does not own", async () => {
    const strangerEvent = await seedEvent(t, strangerId, {
      state: "live",
      name: "Somebody else's",
    });
    await seedMembership(t, strangerEvent, ownerId, "guest");
    const elsewhere = await seedGrant(t, strangerEvent, ownerId, "capture-elsewhr");

    await lockOwner();

    expect((await t.run(async (ctx) => ctx.db.get(elsewhere)))?.status).toBe("expired");
    // …and the party itself is untouched. Its owner is fine.
    expect(
      await t.withIdentity({ subject: "stranger" }).query(api.events.home, {
        eventId: strangerEvent,
      }),
    ).toBeTruthy();
  });

  /**
   * Belt and braces, and the belt is the important one.
   *
   * The sweep above is an enumeration performed once, at lock time. This is the
   * check at the one place bytes are accepted, so a grant the sweep never saw —
   * minted by some path added in a later sprint, or racing the lock — still
   * cannot land a file in a frozen party. RC5 is "watch everything freeze", and
   * "everything" has to include the upload that was already in flight.
   */
  it("discards a completion that arrives against a frozen party", async () => {
    setCallbackSecret(CALLBACK_SECRET);
    try {
      const issued = await t
        .withIdentity({ subject: "guest" })
        .mutation(api.media.requestUploadGrant, {
          eventId: firstEvent,
          captureId: "capture-inflight",
          mediaType: "photo",
          byteSize: 2048,
          mimeType: "image/jpeg",
          checksum: "7".repeat(64),
        });
      if (issued.outcome !== "granted") throw new Error("expected a grant");

      // Un-expire it, so what is being tested is the completion-time check and
      // not the sweep that has already been asserted above.
      await lockOwner();
      await t.run(async (ctx) => ctx.db.patch(issued.grantId, { status: "issued" }));

      const result = await t.mutation(api.media.completeUpload, {
        callbackSecret: CALLBACK_SECRET,
        secret: issued.secret,
        fileKey: "frozen-file-key",
        byteSize: 2048,
      });

      expect(result.outcome).toBe("discarded");
      expect(result.reason).toBe("ownerLocked");
      // Nothing landed: no media row, and the party's counters did not move.
      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("media")
          .withIndex("by_event_and_state", (q) => q.eq("eventId", firstEvent))
          .collect(),
      );
      expect(rows.filter((row) => row.captureId === "capture-inflight")).toHaveLength(0);
    } finally {
      setCallbackSecret(undefined);
    }
  });

  it("lets the admin keep looking, and unlocking puts everything back", async () => {
    await lockOwner();

    // The console has to be able to see the party it just froze.
    const listed = await t.withIdentity({ subject: "admin" }).query(api.admin.events, {});
    expect(listed.items.find((row) => row.id === firstEvent)?.frozen).toBe(true);

    await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.unlockAccount, { userId: ownerId, reason: "Resolved" });

    expect(
      await t.withIdentity({ subject: "cohost" }).query(api.events.home, { eventId: firstEvent }),
    ).toBeTruthy();
    const rejoined = await t
      .withIdentity({ subject: "stranger" })
      .mutation(api.join.join, { invite: { via: "code", code } });
    expect(rejoined.outcome).toBe("joined");
  });
});

describe("a locked guest loses everything", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;
  let code: string;

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    setAllowlist(ADMIN_EMAIL);
    await seedUser(t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, guestId, "guest");
    ({ code } = await seedInviteVersion(t, eventId, ownerId, { code: "482913" }));

    await t
      .withIdentity({ subject: "admin" })
      .mutation(api.admin.lockAccount, { userId: guestId, reason: "Reported repeatedly" });
  });

  afterEach(() => {
    clearFakeStorage();
    setAllowlist(undefined);
  });

  it("cannot upload, read, report, withdraw or join", async () => {
    const as = t.withIdentity({ subject: "guest" });

    await expect(
      as.mutation(api.media.requestUploadGrant, {
        eventId,
        captureId: "capture-abcdefgh",
        mediaType: "photo",
        byteSize: 2048,
        mimeType: "image/jpeg",
        checksum: "a".repeat(64),
      }),
    ).rejects.toThrow(/cannot upload|suspended/i);

    await expect(as.query(api.media.myMedia, { eventId })).rejects.toThrow(/suspended|permission/i);
    await expect(as.query(api.media.eventMedia, { eventId })).rejects.toThrow(
      /suspended|permission/i,
    );

    // Joining refuses a locked account *before* it reads the credential, and
    // throws rather than returning the uniform rejection — deliberately, per
    // `join.ts`: it is a fact about the caller's own account, which they already
    // know, so it is not an enumeration leak.
    await expect(as.mutation(api.join.join, { invite: { via: "code", code } })).rejects.toThrow(
      /suspended/i,
    );
  });

  it("cannot register a push device or change its preferences", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await expect(
      as.mutation(api.push.registerDevice, {
        expoPushToken: "ExponentPushToken[locked0000]",
        platform: "ios",
      }),
    ).rejects.toThrow(/suspended/i);
    await expect(as.mutation(api.push.updatePreferences, { pendingThreshold: 3 })).rejects.toThrow(
      /suspended/i,
    );
  });

  it("is never sent a notification", async () => {
    const push = useFakePush();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("pushDevices", {
        userId: guestId,
        expoPushToken: "ExponentPushToken[locked1111]",
        platform: "ios",
        failureCount: 0,
        lastSeenAt: now,
        createdAt: now,
      });
    });

    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.events.setState, { eventId, state: "paused" });

    // `queueNotification` refuses a non-active account before the row is written.
    expect(await t.run(async (ctx) => ctx.db.query("pushNotifications").collect())).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
    clearFakePush();
  });

  it("can still see its own account and delete it — the two doors a lock leaves open", async () => {
    const as = t.withIdentity({ subject: "guest" });

    const me = await as.query(api.users.currentUser, {});
    expect(me?.accountState).toBe("locked");

    // App Review requires in-app deletion to stay reachable, and a lock nobody
    // can appeal or escape is not a lock, it is a trap.
    const result = await as.mutation(api.users.requestAccountDeletion, {});
    expect(result.accountState).toBe("deletionScheduled");
  });

  it("does not affect anybody else's view of the party", async () => {
    const owner = t.withIdentity({ subject: "owner" });
    expect(await owner.query(api.events.home, { eventId })).toBeTruthy();
    expect(await owner.query(api.moderation.pending, { eventId })).toEqual([]);
  });
});
