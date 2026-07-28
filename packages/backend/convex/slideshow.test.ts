import { decodeMediaCursor } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedMedia,
  seedMembership,
  seedUser,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * The slideshow feed.
 *
 * The cursor is the whole feature, so these suites are mostly about it: a
 * television left running all night re-runs this query on every approval, and
 * the difference between "ask for what I don't have" and "re-read the party" is
 * the difference between a show that keeps playing and one that restarts.
 */

interface Fixture {
  t: T;
  ownerId: Id<"users">;
  guestId: Id<"users">;
  eventId: Id<"events">;
}

async function fixture(): Promise<Fixture> {
  const t = makeTest();
  const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
  const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
  const eventId = await seedEvent(t, ownerId, { state: "live" });
  await seedMembership(t, eventId, guestId, "guest");
  return { t, ownerId, guestId, eventId };
}

const BASE = 1_800_000_000_000;

async function seedApproved(f: Fixture, count: number, from = BASE): Promise<Id<"media">[]> {
  const ids: Id<"media">[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      await seedMedia(f.t, f.eventId, f.guestId, {
        state: "approved",
        createdAt: from + index * 1000,
        sourceMetadataStripped: true,
        previewKey: `ut_preview_${index}`,
      }),
    );
  }
  return ids;
}

beforeEach(() => {
  useFakeStorage();
});

afterEach(() => {
  clearFakeStorage();
});

describe("slideshow.feed", () => {
  it("returns approved media oldest first", async () => {
    const f = await fixture();
    const ids = await seedApproved(f, 3);

    const page = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });

    expect(page.items.map((item) => item.id)).toEqual(ids);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  it("shows only approved media", async () => {
    const f = await fixture();
    await seedApproved(f, 1);
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "declined" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "processing" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "deleted" });

    const page = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    expect(page.items).toHaveLength(1);
  });

  it("resumes from a cursor and returns nothing when nothing is new", async () => {
    const f = await fixture();
    await seedApproved(f, 3);

    const first = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    const second = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId, after: first.nextCursor });

    // Every approval re-runs this query. An empty page is what keeps the
    // currently-displayed photo on screen instead of restarting the show.
    expect(second.items).toHaveLength(0);
    expect(second.nextCursor).toBe(first.nextCursor);
    expect(second.total).toBe(3);
  });

  it("returns only what was approved since the cursor", async () => {
    const f = await fixture();
    await seedApproved(f, 2);

    const first = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });

    const later = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      createdAt: BASE + 10_000,
      sourceMetadataStripped: true,
    });

    const next = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId, after: first.nextCursor });
    expect(next.items.map((item) => item.id)).toEqual([later]);
  });

  it("does not skip or repeat two items sharing a millisecond", async () => {
    const f = await fixture();
    // Fifty phones firing at one party genuinely produce this. A cursor that
    // could not break the tie would drop one of them or loop on it for ever.
    const a = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      createdAt: BASE,
      sourceMetadataStripped: true,
    });
    const b = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      createdAt: BASE,
      sourceMetadataStripped: true,
    });

    const first = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId, after: first.nextCursor });

    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(seen.sort()).toEqual([a, b].sort());
    expect(new Set(seen).size).toBe(2);
  });

  it("pages, and says when there is more", async () => {
    const f = await fixture();
    const ids = await seedApproved(f, 5);

    const page = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId, limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(page.hasMore).toBe(true);
    expect(decodeMediaCursor(page.nextCursor)?.id).toBe(ids[1]);
  });

  it("treats a nonsense cursor as 'start from the beginning'", async () => {
    const f = await fixture();
    await seedApproved(f, 2);
    const page = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId, after: "not-a-cursor" });
    expect(page.items).toHaveLength(2);
  });

  it("carries a preview URL for every item", async () => {
    const f = await fixture();
    await seedApproved(f, 1);
    const page = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    expect(page.items[0]?.previewUrl).toMatch(/^https:\/\/fake\.ufs\.test\//);
  });

  it("returns no file keys", async () => {
    const f = await fixture();
    await seedApproved(f, 1);
    const page = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    expect(JSON.stringify(page)).not.toContain("previewKey");
  });

  it("refuses a guest — presenting is a host power", async () => {
    const f = await fixture();
    await seedApproved(f, 1);
    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.slideshow.feed, { eventId: f.eventId }),
    ).rejects.toThrow(/permission/i);
  });

  it("refuses a stranger with notFound", async () => {
    const f = await fixture();
    await seedUser(f.t, { authId: "stranger", email: "stranger@partybooth.test" });
    await expect(
      f.t.withIdentity({ subject: "stranger" }).query(api.slideshow.feed, { eventId: f.eventId }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("still presents a paused or archived event — looking back is not uploading", async () => {
    const f = await fixture();
    await seedApproved(f, 1);
    for (const state of ["paused", "archived"] as const) {
      await f.t.run(async (ctx) => ctx.db.patch(f.eventId, { state }));
      const page = await f.t
        .withIdentity({ subject: "owner" })
        .query(api.slideshow.feed, { eventId: f.eventId });
      expect(page.items).toHaveLength(1);
    }
  });

  it("refuses to present an event that is not yet open", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => ctx.db.patch(f.eventId, { state: "draft" }));
    await expect(
      f.t.withIdentity({ subject: "owner" }).query(api.slideshow.feed, { eventId: f.eventId }),
    ).rejects.toThrow();
  });
});
