import { SIGNED_READ_URL_TTL_SECONDS } from "@partybooth/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  clearFakeStorage,
  makeTest,
  seedUser,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * `users.updateProfile` is the single writer of the name a host reads in the
 * moderation queue, and the only thing that can answer "has this human ever
 * told us what to call them?".
 *
 * Both properties are worth tests because both used to be wrong in a way that
 * cannot be seen: the name had two authors (the guest, and whatever the
 * identity provider last said), and "confirmed" was a device-local flag that a
 * reinstall lost.
 */
describe("users.updateProfile", () => {
  let t: T;
  let userId: Id<"users">;

  beforeEach(async () => {
    t = makeTest();
    userId = await seedUser(t, {
      authId: "guest-1",
      email: "sam@example.com",
      displayName: "sam",
    });
  });

  function asGuest() {
    return t.withIdentity({ subject: "guest-1" });
  }

  async function readUser() {
    return await t.run(async (ctx) => ctx.db.get(userId));
  }

  it("writes the confirmed name and stamps onboardedAt", async () => {
    const before = await readUser();
    expect(before?.onboardedAt).toBeUndefined();

    const result = await asGuest().mutation(api.users.updateProfile, { displayName: "Sam" });

    expect(result.displayName).toBe("Sam");
    expect(result.onboardedAt).toBeGreaterThan(0);
    expect((await readUser())?.displayName).toBe("Sam");
  });

  it("never moves onboardedAt once it is set", async () => {
    const first = await asGuest().mutation(api.users.updateProfile, { displayName: "Sam" });
    const second = await asGuest().mutation(api.users.updateProfile, {
      displayName: "Sam T",
    });

    expect(second.onboardedAt).toBe(first.onboardedAt);
    expect((await readUser())?.displayName).toBe("Sam T");
  });

  it("applies the contract's own trimming and length rules", async () => {
    const result = await asGuest().mutation(api.users.updateProfile, {
      displayName: "   Sam   ",
    });
    expect(result.displayName).toBe("Sam");

    await expect(
      asGuest().mutation(api.users.updateProfile, { displayName: "   " }),
    ).rejects.toThrow();
  });

  it("keeps a server-confirmed avatar when the name changes", async () => {
    await t.run(async (ctx) =>
      ctx.db.patch(userId, { avatarKey: "avatars/sam.jpg", avatarStorageRegion: "pdx1" }),
    );
    const kept = await asGuest().mutation(api.users.updateProfile, { displayName: "Sam T" });
    expect(kept).not.toHaveProperty("avatarKey");
    expect((await readUser())?.avatarKey).toBe("avatars/sam.jpg");
  });

  it("rejects a client trying to set an arbitrary provider key", async () => {
    await expect(
      asGuest().mutation(api.users.updateProfile, {
        displayName: "Sam",
        avatarKey: "somebody-elses-private-file",
      } as never),
    ).rejects.toThrow();
    expect((await readUser())?.avatarKey).toBeUndefined();
  });

  it("refuses a locked account", async () => {
    await t.run(async (ctx) => ctx.db.patch(userId, { accountState: "locked" }));

    await expect(
      asGuest().mutation(api.users.updateProfile, { displayName: "Sam" }),
    ).rejects.toThrow();
  });

  it("refuses an anonymous caller", async () => {
    await expect(t.mutation(api.users.updateProfile, { displayName: "Sam" })).rejects.toThrow();
  });
});

describe("users.currentUser", () => {
  it("reports onboardedAt so a client can tell a chosen name from a defaulted one", async () => {
    const t = makeTest();
    await seedUser(t, { authId: "guest-1", email: "sam@example.com", displayName: "sam" });
    const guest = t.withIdentity({ subject: "guest-1" });

    // `displayName` is never empty — it falls back to the local part of the
    // address — so it cannot distinguish these two states on its own.
    const before = await guest.query(api.users.currentUser, {});
    expect(before?.displayName).toBe("sam");
    expect(before?.onboardedAt).toBeUndefined();

    await guest.mutation(api.users.updateProfile, { displayName: "Sam" });

    const after = await guest.query(api.users.currentUser, {});
    expect(after?.displayName).toBe("Sam");
    expect(after?.onboardedAt).toBeGreaterThan(0);
  });

  it("returns a short-lived signed avatar URL and never its provider key", async () => {
    const now = 1_900_000_000_000;
    useFakeStorage({ now: () => now });
    try {
      const t = makeTest();
      const userId = await seedUser(t, {
        authId: "guest-avatar",
        email: "avatar@example.com",
      });
      await t.run(async (ctx) =>
        ctx.db.patch(userId, {
          avatarKey: "private/avatar.jpg",
          avatarStorageRegion: "pdx1",
        }),
      );

      const current = await t
        .withIdentity({ subject: "guest-avatar" })
        .query(api.users.currentUser, { urlRefreshKey: 1 });
      expect(current?.avatarUrl).toContain("private%2Favatar.jpg");
      expect(current?.avatarUrlExpiresAt).toBe(now + SIGNED_READ_URL_TTL_SECONDS * 1_000);
      expect(current).not.toHaveProperty("avatarKey");
    } finally {
      clearFakeStorage();
    }
  });
});
