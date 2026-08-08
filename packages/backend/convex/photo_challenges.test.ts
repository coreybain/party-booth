import { describe, expect, it } from "vitest";

import { api, makeTest, seedEvent, seedMembership, seedUser } from "./testing.helpers";

const HOUR = 60 * 60 * 1000;

describe("photo challenges", () => {
  it("enables a 24-prompt starter deck for new events while old rows default off", async () => {
    const t = makeTest();
    const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    const oldEventId = await seedEvent(t, ownerId);
    const oldResult = await t
      .withIdentity({ subject: "owner" })
      .mutation(api.photo_challenges.currentOrDraw, { eventId: oldEventId });
    expect(oldResult).toEqual({ outcome: "disabled", reason: "hostDisabled" });

    const created = await t.withIdentity({ subject: "owner" }).mutation(api.events.create, {
      name: "Challenge party",
      schedule: {
        startsAt: Date.now() + HOUR,
        endsAt: Date.now() + 3 * HOUR,
        timeZone: "Australia/Sydney",
      },
    });
    const deck = await t
      .withIdentity({ subject: "owner" })
      .query(api.photo_challenges.list, { eventId: created.eventId });
    expect(deck.enabled).toBe(true);
    expect(deck.activeCount).toBe(24);
    expect(deck.challenges.every((challenge) => challenge.source === "starter")).toBe(true);
  });

  it("lets owners and co-hosts manage prompts, rejects duplicates, and refuses guests", async () => {
    const t = makeTest();
    const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    const cohostId = await seedUser(t, { authId: "cohost", email: "co@partybooth.test" });
    const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    const eventId = await seedEvent(t, ownerId);
    await seedMembership(t, eventId, cohostId, "cohost");
    await seedMembership(t, eventId, guestId, "guest");

    const created = await t
      .withIdentity({ subject: "cohost" })
      .mutation(api.photo_challenges.create, { eventId, prompt: "  Find a reflection  " });
    expect(created.prompt).toBe("Find a reflection");
    await expect(
      t
        .withIdentity({ subject: "owner" })
        .mutation(api.photo_challenges.create, { eventId, prompt: "FIND   A REFLECTION" }),
    ).rejects.toThrow(/already/i);
    await expect(
      t.withIdentity({ subject: "guest" }).query(api.photo_challenges.list, { eventId }),
    ).rejects.toThrow(/permission/i);
  });

  it("does not repeat within an active-deck cycle", async () => {
    const t = makeTest();
    const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    const eventId = await seedEvent(t, ownerId);
    await seedMembership(t, eventId, guestId, "guest");
    await t.run(async (ctx) => {
      await ctx.db.patch(eventId, { photoChallengesEnabled: true });
      for (const prompt of ["One", "Two", "Three"]) {
        await ctx.db.insert("photoChallenges", {
          eventId,
          prompt,
          normalizedPrompt: prompt.toLowerCase(),
          status: "active",
          source: "custom",
          createdByUserId: ownerId,
          updatedByUserId: ownerId,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });

    const asGuest = t.withIdentity({ subject: "guest" });
    let result = await asGuest.mutation(api.photo_challenges.currentOrDraw, { eventId });
    const prompts: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      expect(result.outcome).toBe("available");
      if (result.outcome !== "available") throw new Error("expected assignment");
      prompts.push(result.assignment.prompt);
      result = await asGuest.mutation(api.photo_challenges.skip, {
        assignmentId: result.assignment.id,
      });
    }
    expect(new Set(prompts).size).toBe(3);
    expect(result.outcome).toBe("available");
    if (result.outcome === "available") expect(result.assignment.cycle).toBe(2);
  });

  it("keeps the assigned snapshot when a host edits the deck and trusts it through the grant", async () => {
    const t = makeTest();
    const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    const eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, guestId, "guest");
    await t.run(async (ctx) => {
      await ctx.db.patch(eventId, { photoChallengesEnabled: true });
      for (const prompt of ["Original prompt", "Second prompt", "Third prompt"]) {
        await ctx.db.insert("photoChallenges", {
          eventId,
          prompt,
          normalizedPrompt: prompt.toLowerCase(),
          status: "active",
          source: "custom",
          createdByUserId: ownerId,
          updatedByUserId: ownerId,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    const asGuest = t.withIdentity({ subject: "guest" });
    const drawn = await asGuest.mutation(api.photo_challenges.currentOrDraw, { eventId });
    if (drawn.outcome !== "available") throw new Error("expected assignment");
    const snapshot = drawn.assignment.prompt;

    await t.withIdentity({ subject: "owner" }).mutation(api.photo_challenges.update, {
      challengeId: drawn.assignment.challengeId,
      prompt: `${snapshot} edited`,
    });
    await asGuest.mutation(api.photo_challenges.resolve, {
      assignmentId: drawn.assignment.id,
      outcome: "used",
      captureId: "capture_123",
    });
    const grant = await asGuest.mutation(api.media.requestUploadGrant, {
      eventId,
      captureId: "capture_123",
      mediaType: "photo",
      byteSize: 100,
      mimeType: "image/jpeg",
      checksum: "a".repeat(64),
      mediaSource: "capture",
      sourceMetadataStripped: true,
      challengeAssignmentId: drawn.assignment.id,
    });
    expect(grant.outcome).toBe("granted");
    if (grant.outcome !== "granted") throw new Error("expected grant");
    const row = await t.run(async (ctx) => ctx.db.get(grant.grantId));
    expect(row?.challengePrompt).toBe(snapshot);
  });
});
