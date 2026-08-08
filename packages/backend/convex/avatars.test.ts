import { AVATAR_GRANT_POLICY } from "@partybooth/contracts/avatar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  CALLBACK_SECRET,
  clearFakeStorage,
  internal,
  makeTest,
  runScheduled,
  seedUser,
  setCallbackSecret,
  useFakeStorage,
  type T,
} from "./testing.helpers";

const CHECKSUM = "a".repeat(64);
const FILE_KEY = "private/avatar-new.jpg";

interface Fixture {
  t: T;
  userId: Id<"users">;
}

async function fixture(): Promise<Fixture> {
  const t = makeTest();
  const userId = await seedUser(t, {
    authId: "avatar-user",
    email: "avatar@partybooth.test",
  });
  return { t, userId };
}

function requestArgs(over: Record<string, unknown> = {}) {
  return { byteSize: 1_024, mimeType: "image/jpeg", checksum: CHECKSUM, ...over };
}

async function issue(f: Fixture) {
  return await f.t
    .withIdentity({ subject: "avatar-user" })
    .mutation(api.avatars.requestUploadGrant, requestArgs());
}

function completionArgs(secret: string, over: Record<string, unknown> = {}) {
  return {
    callbackSecret: CALLBACK_SECRET,
    secret,
    fileKey: FILE_KEY,
    byteSize: 1_024,
    mimeType: "image/jpeg",
    checksum: CHECKSUM,
    ...over,
  };
}

async function preflight(f: Fixture, secret: string) {
  return await f.t
    .withIdentity({ subject: "avatar-user" })
    .mutation(api.avatars.confirmUpload, { secret });
}

beforeEach(() => setCallbackSecret(CALLBACK_SECRET));
afterEach(() => {
  setCallbackSecret(undefined);
  clearFakeStorage();
});

describe("avatars upload lifecycle", () => {
  it("issues a short-lived exact-file capability and stores only its hash", async () => {
    const f = await fixture();
    const before = Date.now();
    const grant = await issue(f);

    expect(grant).toMatchObject(requestArgs());
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + AVATAR_GRANT_POLICY.ttlMs);
    const rows = await f.t.run(async (ctx) => ctx.db.query("avatarUploadGrants").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secretHash).not.toBe(grant.secret);
    expect(JSON.stringify(rows[0])).not.toContain(grant.secret);
  });

  it("expires an older unspent capability and refuses a different account", async () => {
    const f = await fixture();
    const first = await issue(f);
    await preflight(f, first.secret);
    const second = await issue(f);
    await seedUser(f.t, { authId: "stranger", email: "stranger@partybooth.test" });

    await expect(
      f.t.withIdentity({ subject: "avatar-user" }).mutation(api.avatars.confirmUpload, {
        secret: first.secret,
      }),
    ).rejects.toThrow();
    await expect(
      f.t.withIdentity({ subject: "stranger" }).mutation(api.avatars.confirmUpload, {
        secret: second.secret,
      }),
    ).rejects.toThrow();
    await expect(
      f.t.withIdentity({ subject: "avatar-user" }).mutation(api.avatars.confirmUpload, {
        secret: second.secret,
      }),
    ).resolves.toEqual(requestArgs());
  });

  it("reserves once and lets a transfer finish after the start TTL", async () => {
    const f = await fixture();
    const grant = await issue(f);
    await preflight(f, grant.secret);
    await expect(preflight(f, grant.secret)).rejects.toThrow(/could not be found/i);

    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("avatarUploadGrants").withIndex("by_secretHash").first();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });

    await expect(
      f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret)),
    ).resolves.toEqual({ outcome: "registered" });
    const rows = await f.t.run(async (ctx) => ctx.db.query("avatarUploadGrants").collect());
    expect(rows[0]).toMatchObject({ status: "consumed" });
    expect(rows[0]?.startedAt).toBeDefined();
  });

  it("discards a callback that bypassed authenticated avatar preflight", async () => {
    const storage = useFakeStorage();
    const f = await fixture();
    const grant = await issue(f);
    storage.put(FILE_KEY, 1_024);

    await expect(
      f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret)),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "notStarted" });
    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(false);
  });

  it("attaches only a callback-confirmed key and makes duplicate delivery idempotent", async () => {
    const storage = useFakeStorage();
    const f = await fixture();
    const grant = await issue(f);
    storage.put(FILE_KEY, 1_024);
    await preflight(f, grant.secret);

    await expect(
      f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret)),
    ).resolves.toEqual({ outcome: "registered" });
    await expect(
      f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret)),
    ).resolves.toEqual({ outcome: "duplicate" });

    const user = await f.t.run(async (ctx) => ctx.db.get(f.userId));
    expect(user?.avatarKey).toBe(FILE_KEY);
    const current = await f.t
      .withIdentity({ subject: "avatar-user" })
      .query(api.users.currentUser, { urlRefreshKey: 1 });
    expect(current?.avatarUrl).toContain("private%2Favatar-new.jpg");
    expect(current).not.toHaveProperty("avatarKey");
  });

  it("discards mismatched bytes and a different-key replay", async () => {
    const storage = useFakeStorage();
    const f = await fixture();
    const mismatch = await issue(f);
    storage.put("private/mismatch.jpg", 2_048);
    await preflight(f, mismatch.secret);

    await expect(
      f.t.mutation(
        api.avatars.completeUpload,
        completionArgs(mismatch.secret, {
          fileKey: "private/mismatch.jpg",
          byteSize: 2_048,
        }),
      ),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "fileMismatch" });
    await runScheduled(f.t);
    expect(storage.has("private/mismatch.jpg")).toBe(false);

    const grant = await issue(f);
    storage.put(FILE_KEY, 1_024);
    await preflight(f, grant.secret);
    await f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret));
    storage.put("private/replay.jpg", 1_024);
    await expect(
      f.t.mutation(
        api.avatars.completeUpload,
        completionArgs(grant.secret, { fileKey: "private/replay.jpg" }),
      ),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "alreadyConsumed" });
    await runScheduled(f.t);
    expect(storage.has("private/replay.jpg")).toBe(false);
    expect((await f.t.run(async (ctx) => ctx.db.get(f.userId)))?.avatarKey).toBe(FILE_KEY);
  });

  it("deletes the previous private object after a successful replacement", async () => {
    const storage = useFakeStorage();
    const f = await fixture();
    storage.put("private/avatar-old.jpg", 900);
    storage.put(FILE_KEY, 1_024);
    await f.t.run(async (ctx) =>
      ctx.db.patch(f.userId, {
        avatarKey: "private/avatar-old.jpg",
        avatarStorageRegion: "pdx1",
      }),
    );
    const grant = await issue(f);

    await preflight(f, grant.secret);
    await f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret));
    await runScheduled(f.t);
    expect(storage.has("private/avatar-old.jpg")).toBe(false);
    expect(storage.has(FILE_KEY)).toBe(true);
    const jobs = await f.t.run(async (ctx) => ctx.db.query("storagePurgeJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "avatarReplacement",
      state: "completed",
      requested: 1,
      deleted: 1,
    });
    expect(jobs[0]?.keys).toBeUndefined();
  });

  it("removes the current avatar and durably purges its private object", async () => {
    const storage = useFakeStorage();
    const f = await fixture();
    storage.put(FILE_KEY, 1_024);
    await f.t.run(async (ctx) =>
      ctx.db.patch(f.userId, { avatarKey: FILE_KEY, avatarStorageRegion: "pdx1" }),
    );

    await expect(
      f.t.withIdentity({ subject: "avatar-user" }).mutation(api.avatars.remove, {}),
    ).resolves.toBeNull();
    const user = await f.t.run(async (ctx) => ctx.db.get(f.userId));
    expect(user?.avatarKey).toBeUndefined();
    expect(user?.avatarStorageRegion).toBeUndefined();

    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(false);
    const jobs = await f.t.run(async (ctx) => ctx.db.query("storagePurgeJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "avatarRemoval",
      state: "completed",
      requested: 1,
      deleted: 1,
    });
    expect(jobs[0]?.keys).toBeUndefined();

    await expect(
      f.t.withIdentity({ subject: "avatar-user" }).mutation(api.avatars.remove, {}),
    ).resolves.toBeNull();
  });

  it("retains a durable avatar key when replacement cleanup exhausts retries", async () => {
    const storage = useFakeStorage({ failDeletes: true });
    const f = await fixture();
    storage.put("private/avatar-old.jpg", 900);
    storage.put(FILE_KEY, 1_024);
    await f.t.run(async (ctx) =>
      ctx.db.patch(f.userId, {
        avatarKey: "private/avatar-old.jpg",
        avatarStorageRegion: "pdx1",
      }),
    );
    const grant = await issue(f);
    await preflight(f, grant.secret);
    await f.t.mutation(api.avatars.completeUpload, completionArgs(grant.secret));

    const job = await f.t.run(async (ctx) => ctx.db.query("storagePurgeJobs").first());
    if (!job) throw new Error("expected a durable purge job");
    if (!job.keys) throw new Error("pending purge job lost its keys");
    await f.t.action(internal.media.purgeStoredFile, {
      region: job.region,
      keys: job.keys,
      purgeJobId: job._id,
      attempt: 99,
    });

    const stuck = await f.t.run(async (ctx) => ctx.db.get(job._id));
    expect(stuck).toMatchObject({
      state: "stuck",
      keys: ["private/avatar-old.jpg"],
      lastError: "deleteFailed",
    });
    expect((await f.t.run(async (ctx) => ctx.db.get(f.userId)))?.avatarKey).toBe(FILE_KEY);
  });

  it("requires the server callback secret", async () => {
    const f = await fixture();
    const grant = await issue(f);
    await expect(
      f.t.mutation(
        api.avatars.completeUpload,
        completionArgs(grant.secret, { callbackSecret: "not-the-server" }),
      ),
    ).rejects.toThrow();
  });
});

describe("avatar account deletion", () => {
  it("expires an in-flight avatar capability as soon as deletion is requested", async () => {
    const f = await fixture();
    const grant = await issue(f);
    await preflight(f, grant.secret);

    await f.t
      .withIdentity({ subject: "avatar-user" })
      .mutation(api.users.requestAccountDeletion, {});

    const rows = await f.t.run(async (ctx) => ctx.db.query("avatarUploadGrants").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("expired");
    await expect(
      f.t.withIdentity({ subject: "avatar-user" }).mutation(api.avatars.confirmUpload, {
        secret: grant.secret,
      }),
    ).rejects.toThrow();
  });

  it("purges the object and all avatar grant history with the account", async () => {
    const storage = useFakeStorage();
    const f = await fixture();
    storage.put(FILE_KEY, 1_024);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.userId, {
        avatarKey: FILE_KEY,
        avatarStorageRegion: "pdx1",
        accountState: "deletionScheduled",
      });
      await ctx.db.insert("deletionJobs", {
        subjectType: "user",
        subjectId: f.userId,
        state: "scheduled",
        scheduledAt: 1,
        createdAt: 1,
      });
      await ctx.db.insert("avatarUploadGrants", {
        userId: f.userId,
        secretHash: "dead-grant-hash",
        status: "consumed",
        storageRegion: "pdx1",
        byteSize: 1_024,
        mimeType: "image/jpeg",
        checksum: CHECKSUM,
        issuedAt: 1,
        expiresAt: 2,
        consumedAt: 2,
        consumedFileKey: FILE_KEY,
        createdAt: 1,
        updatedAt: 2,
      });
    });

    await f.t.mutation(internal.deletion.runDueDeletions, { now: 3 });
    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(false);
    expect(await f.t.run(async (ctx) => ctx.db.query("avatarUploadGrants").collect())).toEqual([]);
    const user = await f.t.run(async (ctx) => ctx.db.get(f.userId));
    expect(user?.avatarKey).toBeUndefined();
    expect(user?.avatarStorageRegion).toBeUndefined();
    expect(user?.accountState).toBe("deleted");
    const jobs = await f.t.run(async (ctx) => ctx.db.query("storagePurgeJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "accountAvatar",
      state: "completed",
    });
    expect(jobs[0]?.keys).toBeUndefined();
  });

  it("keeps the deleted account's avatar key in a stuck job after provider failure", async () => {
    const storage = useFakeStorage({ failDeletes: true });
    const f = await fixture();
    storage.put(FILE_KEY, 1_024);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.userId, {
        avatarKey: FILE_KEY,
        avatarStorageRegion: "pdx1",
        accountState: "deletionScheduled",
      });
      await ctx.db.insert("deletionJobs", {
        subjectType: "user",
        subjectId: f.userId,
        state: "scheduled",
        scheduledAt: 1,
        createdAt: 1,
      });
    });

    await f.t.mutation(internal.deletion.runDueDeletions, { now: 3 });
    const job = await f.t.run(async (ctx) => ctx.db.query("storagePurgeJobs").first());
    if (!job) throw new Error("expected a durable purge job");
    if (!job.keys) throw new Error("pending purge job lost its keys");
    await f.t.action(internal.media.purgeStoredFile, {
      region: job.region,
      keys: job.keys,
      purgeJobId: job._id,
      attempt: 99,
    });

    expect(await f.t.run(async (ctx) => ctx.db.get(job._id))).toMatchObject({
      source: "accountAvatar",
      state: "stuck",
      keys: [FILE_KEY],
      lastError: "deleteFailed",
    });
    const user = await f.t.run(async (ctx) => ctx.db.get(f.userId));
    expect(user).toMatchObject({ accountState: "deleted" });
    expect(user?.avatarKey).toBeUndefined();
    expect(storage.has(FILE_KEY)).toBe(true);
  });
});
