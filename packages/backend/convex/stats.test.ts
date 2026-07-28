import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  ADMIN_EMAIL,
  api,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedMedia,
  seedMembership,
  seedUser,
  setAllowlist,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * The organiser home.
 *
 * Two queries with two different audiences, and the split is the point: an admin
 * may see how big a party is and may never see the pictures in it (PLAN.md, "no
 * media access"). Every "guests get nothing" assertion below is really an
 * assertion that a convenience endpoint did not quietly become the exception to
 * the permission matrix.
 */

interface Fixture {
  t: T;
  ownerId: Id<"users">;
  cohostId: Id<"users">;
  guestId: Id<"users">;
  otherGuestId: Id<"users">;
  eventId: Id<"events">;
}

async function fixture(): Promise<Fixture> {
  const t = makeTest();
  const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
  const cohostId = await seedUser(t, { authId: "cohost", email: "cohost@partybooth.test" });
  const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
  const otherGuestId = await seedUser(t, { authId: "other", email: "other@partybooth.test" });
  const eventId = await seedEvent(t, ownerId, { state: "live" });
  await seedMembership(t, eventId, cohostId, "cohost");
  await seedMembership(t, eventId, guestId, "guest");
  await seedMembership(t, eventId, otherGuestId, "guest");
  return { t, ownerId, cohostId, guestId, otherGuestId, eventId };
}

beforeEach(() => {
  useFakeStorage();
});

afterEach(() => {
  clearFakeStorage();
  setAllowlist(undefined);
});

describe("stats.overview", () => {
  it("reports the pending badge, the totals and the split by state and type", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending", mediaType: "video" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "declined" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "processing" });

    const stats = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.overview, { eventId: f.eventId });

    expect(stats).toMatchObject({
      pending: 2,
      approved: 1,
      declined: 1,
      byType: { photo: 4, video: 1 },
      byState: { processing: 1, pending: 2, approved: 1, declined: 1 },
    });
    // `processing` is counted separately and stays out of the pending badge: the
    // badge must not blink for a photo that is still uploading.
    expect(stats.processing).toBe(1);
  });

  it("excludes withdrawn items from every figure", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "deleted" });

    const stats = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.overview, { eventId: f.eventId });
    expect(stats.byType.photo).toBe(1);
    expect(stats.storageBytes).toBe(1024);
  });

  it("sums derivatives into the storage figure, not just originals", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      byteSize: 1_000_000,
      previewKey: "ut_preview_1",
      previewByteSize: 50_000,
      posterKey: "ut_poster_1",
      posterByteSize: 20_000,
      mediaType: "video",
    });

    // Counting only originals told a host their party was a third smaller than
    // it actually is in storage.
    const stats = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.overview, { eventId: f.eventId });
    expect(stats.storageBytes).toBe(1_070_000);
  });

  it("ranks contributors by approved count", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "declined" });

    const stats = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.overview, { eventId: f.eventId });

    expect(stats.contributorCount).toBe(2);
    expect(stats.topContributors[0]).toMatchObject({
      userId: f.guestId,
      approved: 2,
      total: 3,
    });
    expect(stats.topContributors[1]).toMatchObject({ userId: f.otherGuestId, approved: 1 });
  });

  it("anonymises a contributor whose account is on its way out", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await f.t.withIdentity({ subject: "guest" }).mutation(api.users.requestAccountDeletion, {});

    const stats = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.overview, { eventId: f.eventId });
    expect(stats.topContributors[0]?.displayName).toBe("Former guest");
  });

  it("counts flagged items", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.moderation.report, { mediaId, reason: "other" });

    const stats = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.overview, { eventId: f.eventId });
    expect(stats.flagged).toBe(1);
  });

  it("is readable by a co-host", async () => {
    const f = await fixture();
    const stats = await f.t
      .withIdentity({ subject: "cohost" })
      .query(api.stats.overview, { eventId: f.eventId });
    expect(stats.total).toBe(0);
  });

  it("gives a guest nothing at all", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    // Not an empty shape — an error. How big the party is, and who is
    // contributing most to it, is the host's information.
    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.stats.overview, { eventId: f.eventId }),
    ).rejects.toThrow(/permission/i);
  });

  it("gives a stranger notFound rather than forbidden", async () => {
    const f = await fixture();
    await seedUser(f.t, { authId: "stranger", email: "stranger@partybooth.test" });
    await expect(
      f.t.withIdentity({ subject: "stranger" }).query(api.stats.overview, { eventId: f.eventId }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("refuses an unauthenticated caller", async () => {
    const f = await fixture();
    await expect(f.t.query(api.stats.overview, { eventId: f.eventId })).rejects.toThrow();
  });
});

describe("stats.recentSubmissions", () => {
  it("returns the newest first, with thumbnails", async () => {
    const f = await fixture();
    const now = Date.now();
    const older = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      createdAt: now - 10_000,
      previewKey: "ut_preview_old",
    });
    const newer = await seedMedia(f.t, f.eventId, f.otherGuestId, {
      state: "pending",
      createdAt: now,
      previewKey: "ut_preview_new",
    });

    const recent = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.recentSubmissions, { eventId: f.eventId });

    expect(recent.map((item) => item.media.id)).toEqual([newer, older]);
    expect(recent[0]?.media.previewUrl).toMatch(/ut_preview_new/);
    // `processing` and `pending` are included: "three photos are uploading right
    // now" is the reassurance a host standing next to a guest wants.
    expect(recent[0]?.state).toBe("pending");
  });

  it("honours the limit", async () => {
    const f = await fixture();
    for (let index = 0; index < 5; index += 1) {
      await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    }
    const recent = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.recentSubmissions, { eventId: f.eventId, recentLimit: 2 });
    expect(recent).toHaveLength(2);
  });

  it("excludes withdrawn items", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "deleted" });
    const recent = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.stats.recentSubmissions, { eventId: f.eventId });
    expect(recent).toHaveLength(0);
  });

  it("gives a guest nothing", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await expect(
      f.t
        .withIdentity({ subject: "guest" })
        .query(api.stats.recentSubmissions, { eventId: f.eventId }),
    ).rejects.toThrow();
  });

  it("gives a global admin nothing, because admins never look at guests' photos", async () => {
    const f = await fixture();
    setAllowlist(ADMIN_EMAIL);
    await seedUser(f.t, { authId: "admin", email: ADMIN_EMAIL, isGlobalAdmin: true });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });

    // The admin *can* read the numbers…
    const stats = await f.t
      .withIdentity({ subject: "admin" })
      .query(api.stats.overview, { eventId: f.eventId });
    expect(stats.total).toBe(1);

    // …and must not reach anything that mints a signed URL.
    await expect(
      f.t
        .withIdentity({ subject: "admin" })
        .query(api.stats.recentSubmissions, { eventId: f.eventId }),
    ).rejects.toThrow();
  });
});
