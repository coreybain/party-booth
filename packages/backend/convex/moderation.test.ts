import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import {
  api,
  auditRows,
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
 * Moderation, reporting and blocking.
 *
 * The three things this file exists to pin down, because each of them is a
 * promise made somewhere else that only code can keep:
 *
 * - **Revoking an approval takes an item off the wall immediately.** The
 *   slideshow and the gallery are reactive queries over `approved`, so "removed
 *   from the gallery" is really "the state moved and the counters moved with
 *   it" — asserted here rather than assumed from the subscription.
 * - **Declined is visible only to hosts and the submitter.** PLAN.md's privacy
 *   invariant, enforced by `canSeeMedia`, checked from all three sides.
 * - **A report flags, it does not moderate.** Otherwise any guest has a veto
 *   over any other guest's photograph.
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

const row = (f: Fixture, mediaId: Id<"media">) => f.t.run(async (ctx) => ctx.db.get(mediaId));
const event = (f: Fixture) => f.t.run(async (ctx) => ctx.db.get(f.eventId));
const decisions = (f: Fixture) =>
  f.t.run(async (ctx) => ctx.db.query("moderationDecisions").collect());

beforeEach(() => {
  useFakeStorage();
});

afterEach(() => {
  clearFakeStorage();
});

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

describe("moderation.moderate", () => {
  it("approves a pending item and moves the counters with it", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });

    const result = await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "approve",
    });

    expect(result).toMatchObject({ changed: 1, unchanged: 0, refused: [] });
    expect((await row(f, mediaId))?.state).toBe("approved");
    // Exact, in the same transaction. The badge on a host's phone must not
    // disagree with the queue they are about to open.
    expect((await event(f))?.counts).toMatchObject({ pending: 0, approved: 1, total: 1 });
  });

  it("records who decided, when, and what it was before", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await f.t.withIdentity({ subject: "cohost" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "decline",
      reason: "Blurry",
    });

    const [decision] = await decisions(f);
    expect(decision).toMatchObject({
      mediaId,
      eventId: f.eventId,
      decision: "declined",
      actor: "host",
      decidedByUserId: f.cohostId,
      previousState: "pending",
      reason: "Blurry",
    });

    const after = await row(f, mediaId);
    expect(after?.moderatedByUserId).toBe(f.cohostId);
    expect(after?.moderatedAt).toBeGreaterThan(0);
  });

  it("audits every decision", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "approve",
    });

    const audit = (await auditRows(f.t)).find(
      (entry) => entry.action === AUDIT_ACTIONS.mediaModerated,
    );
    expect(audit).toMatchObject({ subjectId: mediaId, actorUserId: f.ownerId });
    expect(audit?.metadata).toMatchObject({
      moderationAction: "approve",
      previousState: "pending",
      state: "approved",
    });
  });

  it("un-declines, because hosts change their mind", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "declined" });
    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "approve",
    });
    expect((await row(f, mediaId))?.state).toBe("approved");
    expect((await event(f))?.counts).toMatchObject({ declined: 0, approved: 1 });
  });

  it("is idempotent — a second tap writes no second decision", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    const args = { eventId: f.eventId, mediaIds: [mediaId], action: "approve" as const };

    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, args);
    const second = await f.t
      .withIdentity({ subject: "owner" })
      .mutation(api.moderation.moderate, args);

    expect(second).toMatchObject({ changed: 0, unchanged: 1 });
    expect(await decisions(f)).toHaveLength(1);
    expect((await event(f))?.counts).toMatchObject({ approved: 1, total: 1 });
  });

  it("refuses to moderate something still uploading", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "processing" });
    const result = await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "approve",
    });

    expect(result.refused).toEqual([
      expect.objectContaining({ mediaId, reason: "stillProcessing" }),
    ]);
    expect((await row(f, mediaId))?.state).toBe("processing");
  });

  it("refuses to moderate something withdrawn, in any direction", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "deleted" });
    for (const action of ["approve", "decline", "revoke"] as const) {
      const result = await f.t
        .withIdentity({ subject: "owner" })
        .mutation(api.moderation.moderate, { eventId: f.eventId, mediaIds: [mediaId], action });
      expect(result.refused[0]).toMatchObject({ reason: "withdrawn" });
    }
    expect((await row(f, mediaId))?.state).toBe("deleted");
  });
});

/* -------------------------------------------------------------------------- */
/* Revoking                                                                   */
/* -------------------------------------------------------------------------- */

describe("revoking an approval", () => {
  it("takes it out of the gallery and the slideshow immediately", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });

    const before = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(before).toHaveLength(1);

    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "revoke",
    });

    // The gallery and the slideshow are reactive queries over `approved`, so
    // "removed immediately" is the state having moved. Both are checked, because
    // the slideshow reads a different index.
    const after = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(after).toHaveLength(0);

    const show = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    expect(show.items).toHaveLength(0);
    expect(show.total).toBe(0);
  });

  it("lands in declined, so hosts and the submitter can still see it", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "revoke",
    });

    expect((await row(f, mediaId))?.state).toBe("declined");
    expect((await event(f))?.counts).toMatchObject({ approved: 0, declined: 1, total: 1 });
  });

  it("refuses to revoke something that was never approved", async () => {
    const f = await fixture();
    const pendingId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    const result = await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [pendingId],
      action: "revoke",
    });

    // "Un-approve this" must not silently become "decline this thing nobody
    // approved" when two hosts are working the same grid.
    expect(result.refused[0]).toMatchObject({ reason: "notApproved" });
    expect((await row(f, pendingId))?.state).toBe("pending");
  });

  it("writes a declined decision carrying the approved prior state", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "revoke",
      reason: "Someone asked",
    });

    const [decision] = await decisions(f);
    expect(decision).toMatchObject({ decision: "declined", previousState: "approved" });
  });
});

/* -------------------------------------------------------------------------- */
/* Bulk                                                                       */
/* -------------------------------------------------------------------------- */

describe("bulk moderation", () => {
  it("applies to every item and counts what moved", async () => {
    const f = await fixture();
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" }));
    }

    const result = await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: ids,
      action: "approve",
    });

    expect(result.changed).toBe(5);
    expect((await event(f))?.counts).toMatchObject({ pending: 0, approved: 5, total: 5 });
    expect(await decisions(f)).toHaveLength(5);
  });

  it("succeeds partially rather than failing the whole selection", async () => {
    const f = await fixture();
    const pendingId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    const processingId = await seedMedia(f.t, f.eventId, f.guestId, { state: "processing" });
    const withdrawnId = await seedMedia(f.t, f.eventId, f.guestId, { state: "deleted" });

    // A grid that has been live for thirty seconds *will* contain items another
    // host has dealt with and items the submitter has withdrawn since.
    const result = await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [pendingId, processingId, withdrawnId],
      action: "approve",
    });

    expect(result.changed).toBe(1);
    expect(result.refused.map((item) => item.reason).sort()).toEqual([
      "stillProcessing",
      "withdrawn",
    ]);
    expect((await row(f, pendingId))?.state).toBe("approved");
  });

  it("counts a repeated id once", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    const result = await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId, mediaId, mediaId],
      action: "approve",
    });
    expect(result.changed).toBe(1);
    expect((await event(f))?.counts.approved).toBe(1);
  });

  it("refuses a selection containing another party's media", async () => {
    const f = await fixture();
    const otherEventId = await seedEvent(f.t, f.ownerId, { name: "Another party" });
    const mine = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    const theirs = await seedMedia(f.t, otherEventId, f.guestId, { state: "pending" });

    // `mediaIds` is a caller-supplied list of document ids. Without the
    // re-check, the argument shape alone moderates somebody else's party.
    await expect(
      f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
        eventId: f.eventId,
        mediaIds: [mine, theirs],
        action: "approve",
      }),
    ).rejects.toThrow(/could not be found/i);

    expect((await row(f, mine))?.state).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */
/* Who may moderate                                                           */
/* -------------------------------------------------------------------------- */

describe("permission isolation", () => {
  it("lets a co-host moderate", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await f.t.withIdentity({ subject: "cohost" }).mutation(api.moderation.moderate, {
      eventId: f.eventId,
      mediaIds: [mediaId],
      action: "approve",
    });
    expect((await row(f, mediaId))?.state).toBe("approved");
  });

  it("refuses a guest", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await expect(
      f.t.withIdentity({ subject: "guest" }).mutation(api.moderation.moderate, {
        eventId: f.eventId,
        mediaIds: [mediaId],
        action: "approve",
      }),
    ).rejects.toThrow(/permission/i);
  });

  it("refuses a guest moderating their own upload", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await expect(
      f.t.withIdentity({ subject: "guest" }).mutation(api.moderation.moderate, {
        eventId: f.eventId,
        mediaIds: [mediaId],
        action: "approve",
      }),
    ).rejects.toThrow(/permission/i);
  });

  it("refuses a stranger with notFound rather than forbidden", async () => {
    const f = await fixture();
    await seedUser(f.t, { authId: "stranger", email: "stranger@partybooth.test" });
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await expect(
      f.t.withIdentity({ subject: "stranger" }).mutation(api.moderation.moderate, {
        eventId: f.eventId,
        mediaIds: [mediaId],
        action: "approve",
      }),
    ).rejects.toThrow(/could not be found/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Declined visibility                                                        */
/* -------------------------------------------------------------------------- */

describe("declined media", () => {
  async function declined(f: Fixture): Promise<Id<"media">> {
    return await seedMedia(f.t, f.eventId, f.guestId, {
      state: "declined",
      sourceMetadataStripped: true,
    });
  }

  it("is hidden from a fellow guest", async () => {
    const f = await fixture();
    await declined(f);
    const seen = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(seen).toHaveLength(0);
  });

  it("is visible to its submitter, so they know what happened to it", async () => {
    const f = await fixture();
    await declined(f);
    const mine = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.myMedia, { eventId: f.eventId });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.state).toBe("declined");
  });

  it("is visible to the hosts", async () => {
    const f = await fixture();
    await declined(f);
    for (const subject of ["owner", "cohost"]) {
      const seen = await f.t
        .withIdentity({ subject })
        .query(api.media.eventMedia, { eventId: f.eventId });
      expect(seen).toHaveLength(1);
    }
  });

  it("never reaches the slideshow", async () => {
    const f = await fixture();
    await declined(f);
    const show = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    expect(show.items).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

describe("moderation.report", () => {
  it("lets any member report somebody else's item, and flags it for the host", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });

    const result = await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.moderation.report, { mediaId, reason: "nudityOrSexual" });

    expect(result).toMatchObject({ created: true, reportCount: 1 });
    const after = await row(f, mediaId);
    expect(after?.flaggedAt).toBeGreaterThan(0);
    // A report is not a decision. Auto-hiding would hand any guest a veto over
    // any other guest's photograph.
    expect(after?.state).toBe("approved");
  });

  it("is idempotent per reporter", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    const args = { mediaId, reason: "other" as const };

    await f.t.withIdentity({ subject: "other" }).mutation(api.moderation.report, args);
    const second = await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.moderation.report, args);

    expect(second).toMatchObject({ created: false, reportCount: 1 });
    expect(await f.t.run(async (ctx) => ctx.db.query("mediaReports").collect())).toHaveLength(1);
  });

  it("counts two different reporters separately", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.otherGuestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.moderation.report, { mediaId, reason: "other" });
    const second = await f.t
      .withIdentity({ subject: "cohost" })
      .mutation(api.moderation.report, { mediaId, reason: "hateOrHarassment" });
    expect(second.reportCount).toBe(2);
  });

  it("refuses a report of your own upload", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    // `mediaGate` refuses `isOwn` for `media.report` — reporting your own upload
    // is meaningless, and `media.withdraw` is the thing that removes it.
    await expect(
      f.t
        .withIdentity({ subject: "guest" })
        .mutation(api.moderation.report, { mediaId, reason: "other" }),
    ).rejects.toThrow(/not available right now/i);
  });

  it("refuses a report of something the reporter cannot see", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    // Otherwise a member could probe for other guests' pending items by watching
    // which ids this mutation accepts.
    await expect(
      f.t
        .withIdentity({ subject: "other" })
        .mutation(api.moderation.report, { mediaId, reason: "other" }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("audits the report without the reporter's free text", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t.withIdentity({ subject: "other" }).mutation(api.moderation.report, {
      mediaId,
      reason: "notMyPhoto",
      details: "this is a picture of my front door",
    });

    const audit = (await auditRows(f.t)).find(
      (entry) => entry.action === AUDIT_ACTIONS.mediaReported,
    );
    expect(audit?.metadata).toMatchObject({ reason: "notMyPhoto" });
    expect(JSON.stringify(audit)).not.toContain("front door");
  });

  it("shows the count to hosts and to nobody else", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.moderation.report, { mediaId, reason: "other" });

    const [asHost] = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(asHost?.reportCount).toBe(1);

    // Telling an uploader they have been reported turns a report into a
    // confrontation; telling a bystander is a leak.
    const [asSubmitter] = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.myMedia, { eventId: f.eventId });
    expect(asSubmitter?.reportCount).toBeUndefined();
  });
});

describe("moderation.flagged", () => {
  it("lists flagged items with their reasons, host-only", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.moderation.report, { mediaId, reason: "violenceOrGore", details: "ugh" });

    const listed = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.moderation.flagged, { eventId: f.eventId });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.media.id).toBe(mediaId);
    expect(listed[0]?.reports[0]).toMatchObject({ reason: "violenceOrGore", status: "open" });

    // The reporter's identity is never returned: a host who knows which guest
    // reported which other guest is a host who can be asked to take sides.
    expect(JSON.stringify(listed)).not.toContain(f.otherGuestId);
  });

  it("refuses a guest", async () => {
    const f = await fixture();
    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.moderation.flagged, { eventId: f.eventId }),
    ).rejects.toThrow(/permission/i);
  });

  it("clears the flag when the last open report is resolved", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    const { reportId } = await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.moderation.report, { mediaId, reason: "other" });

    await f.t.withIdentity({ subject: "owner" }).mutation(api.moderation.resolveReport, {
      reportId,
      status: "dismissed",
    });

    const after = await row(f, mediaId);
    expect(after?.flaggedAt).toBeUndefined();
    // The count is history and survives: a host deciding an item is fine does
    // not un-report it.
    expect(after?.reportCount).toBe(1);
  });

  it("keeps the flag while another report is still open", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.otherGuestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    const first = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.moderation.report, { mediaId, reason: "other" });
    await f.t
      .withIdentity({ subject: "cohost" })
      .mutation(api.moderation.report, { mediaId, reason: "other" });

    const result = await f.t
      .withIdentity({ subject: "owner" })
      .mutation(api.moderation.resolveReport, { reportId: first.reportId, status: "actioned" });

    expect(result.stillFlagged).toBe(true);
    expect((await row(f, mediaId))?.flaggedAt).toBeGreaterThan(0);
  });
});

describe("moderation.pending", () => {
  it("is oldest first — the guest who has waited longest", async () => {
    const f = await fixture();
    const now = Date.now();
    const older = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "pending",
      createdAt: now - 10_000,
    });
    const newer = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "pending",
      createdAt: now,
    });

    const queue = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.moderation.pending, { eventId: f.eventId });
    expect(queue.map((item) => item.id)).toEqual([older, newer]);
  });

  it("puts flagged items first", async () => {
    const f = await fixture();
    const now = Date.now();
    const older = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "pending",
      createdAt: now - 10_000,
    });
    const flaggedId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "pending",
      createdAt: now,
    });
    await f.t.run(async (ctx) => ctx.db.patch(flaggedId, { flaggedAt: now, reportCount: 1 }));

    const queue = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.moderation.pending, { eventId: f.eventId });
    expect(queue[0]?.id).toBe(flaggedId);
    expect(queue[1]?.id).toBe(older);
  });

  it("refuses a guest", async () => {
    const f = await fixture();
    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.moderation.pending, { eventId: f.eventId }),
    ).rejects.toThrow(/permission/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Blocking                                                                   */
/* -------------------------------------------------------------------------- */

describe("blocks", () => {
  it("hides the blocked guest's media from the blocker's gallery", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await seedMedia(f.t, f.eventId, f.cohostId, {
      state: "approved",
      sourceMetadataStripped: true,
    });

    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId });

    const seen = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(seen.map((item) => item.uploaderUserId)).toEqual([f.cohostId]);
  });

  it("changes nothing for anybody else", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId });

    // A block is a filter on the blocker's own reads. It must not be usable as
    // a way to remove somebody else's photo from the party.
    const asCohost = await f.t
      .withIdentity({ subject: "cohost" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(asCohost).toHaveLength(1);
  });

  it("hides them from the blocker's slideshow too", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    await f.t
      .withIdentity({ subject: "owner" })
      .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId });

    const show = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.slideshow.feed, { eventId: f.eventId });
    expect(show.items).toHaveLength(0);
  });

  it("never hides the blocker's own media from them", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    // A self-block cannot be made through the mutation; seeded directly, because
    // a guest who cannot see their own submissions cannot withdraw them.
    await f.t.run(async (ctx) =>
      ctx.db.insert("userBlocks", {
        blockerUserId: f.guestId,
        blockedUserId: f.guestId,
        createdAt: Date.now(),
      }),
    );

    const mine = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.myMedia, { eventId: f.eventId });
    expect(mine.map((item) => item.id)).toContain(mediaId);
  });

  it("still lets a host moderate somebody they blocked", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await f.t
      .withIdentity({ subject: "owner" })
      .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId });

    // Otherwise blocking would be a way for a host to stall their own queue.
    const queue = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.moderation.pending, { eventId: f.eventId });
    expect(queue.map((item) => item.id)).toContain(mediaId);
  });

  it("refuses a self-block", async () => {
    const f = await fixture();
    await expect(
      f.t
        .withIdentity({ subject: "guest" })
        .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId }),
    ).rejects.toThrow(/yourself/i);
  });

  it("is idempotent, and unblocking puts them back", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });
    const args = { eventId: f.eventId, userId: f.guestId };

    await f.t.withIdentity({ subject: "other" }).mutation(api.blocks.block, args);
    const again = await f.t.withIdentity({ subject: "other" }).mutation(api.blocks.block, args);
    expect(again).toMatchObject({ blocked: true, created: false });
    expect(await f.t.run(async (ctx) => ctx.db.query("userBlocks").collect())).toHaveLength(1);

    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.blocks.unblock, { userId: f.guestId });
    const seen = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(seen).toHaveLength(1);
  });

  it("lists the blocker's own blocks and audits both directions", async () => {
    const f = await fixture();
    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId });

    const listed = await f.t.withIdentity({ subject: "other" }).query(api.blocks.myBlocks, {});
    expect(listed).toHaveLength(1);
    expect(listed[0]?.userId).toBe(f.guestId);

    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.blocks.unblock, { userId: f.guestId });
    expect(await f.t.withIdentity({ subject: "other" }).query(api.blocks.myBlocks, {})).toEqual([]);

    const actions = (await auditRows(f.t)).map((entry) => entry.action);
    expect(actions).toContain(AUDIT_ACTIONS.userBlocked);
    expect(actions).toContain(AUDIT_ACTIONS.userUnblocked);
  });

  it("applies everywhere, not only where it was made", async () => {
    const f = await fixture();
    const secondEventId = await seedEvent(f.t, f.ownerId, { name: "Second party" });
    await seedMembership(f.t, secondEventId, f.guestId, "guest");
    await seedMembership(f.t, secondEventId, f.otherGuestId, "guest");
    await seedMedia(f.t, secondEventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });

    await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.blocks.block, { eventId: f.eventId, userId: f.guestId });

    const seen = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: secondEventId });
    expect(seen).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Anonymised submissions                                                     */
/* -------------------------------------------------------------------------- */

describe("an account on its way out", () => {
  it("keeps its submissions and loses its name", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, {
      state: "approved",
      sourceMetadataStripped: true,
    });

    await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.users.requestAccountDeletion, { reason: "Done with this" });

    const seen = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.media.eventMedia, { eventId: f.eventId });

    // PLAN.md keeps the media — the photographs belong to the party as much as
    // to the person who took them — and drops the attribution.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.uploaderDisplayName).toBe("Former guest");
  });

  it("loses access immediately", async () => {
    const f = await fixture();
    await f.t.withIdentity({ subject: "guest" }).mutation(api.users.requestAccountDeletion, {});

    const user = (await f.t.run(async (ctx) => ctx.db.get(f.guestId))) as Doc<"users">;
    expect(user.accountState).toBe("deletionScheduled");
    expect(user.deletionScheduledAt).toBeGreaterThan(0);
    // Never straight to `deleted` — that is the P1 purge worker's state, and
    // reaching it here would make the thirty-day restore window unreachable.
    expect(user.deletedAt).toBeUndefined();

    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.media.myMedia, { eventId: f.eventId }),
    ).rejects.toThrow();
  });

  it("works for an organiser as well as a guest", async () => {
    const f = await fixture();
    await f.t.withIdentity({ subject: "owner" }).mutation(api.users.requestAccountDeletion, {});
    const user = (await f.t.run(async (ctx) => ctx.db.get(f.ownerId))) as Doc<"users">;
    expect(user.accountState).toBe("deletionScheduled");
  });

  it("records the intent and refuses a second request", async () => {
    const f = await fixture();
    await f.t.withIdentity({ subject: "guest" }).mutation(api.users.requestAccountDeletion, {});

    const jobs = await f.t.run(async (ctx) => ctx.db.query("deletionJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ subjectType: "user", state: "scheduled" });

    await expect(
      f.t.withIdentity({ subject: "guest" }).mutation(api.users.requestAccountDeletion, {}),
    ).rejects.toThrow();
  });
});
