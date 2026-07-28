import { AUDIT_ACTIONS, GRANT_POLICY, PHOTO_MAX_BYTES } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  auditActions,
  CALLBACK_SECRET,
  clearFakeStorage,
  makeTest,
  seedEvent,
  seedMedia,
  seedMembership,
  runScheduled,
  seedUser,
  setCallbackSecret,
  useFakeStorage,
  type T,
} from "./testing.helpers";

const CHECKSUM = "a".repeat(64);
const CAPTURE = "capture-00000001";
const FILE_KEY = "ut_file_key_0001";

interface Fixture {
  t: T;
  ownerId: Id<"users">;
  guestId: Id<"users">;
  otherGuestId: Id<"users">;
  eventId: Id<"events">;
}

async function fixture(over: Parameters<typeof seedEvent>[2] = {}): Promise<Fixture> {
  const t = makeTest();
  const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
  const guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
  const otherGuestId = await seedUser(t, { authId: "other", email: "other@partybooth.test" });
  const eventId = await seedEvent(t, ownerId, { state: "live", ...over });
  await seedMembership(t, eventId, guestId, "guest");
  await seedMembership(t, eventId, otherGuestId, "guest");
  return { t, ownerId, guestId, otherGuestId, eventId };
}

function grantArgs(eventId: Id<"events">, over: Record<string, unknown> = {}) {
  return {
    eventId,
    captureId: CAPTURE,
    mediaType: "photo" as const,
    byteSize: 2048,
    mimeType: "image/jpeg",
    checksum: CHECKSUM,
    ...over,
  };
}

/** Ask for a grant as a guest and insist it was issued. */
async function grant(
  f: Fixture,
  over: Record<string, unknown> = {},
  subject = "guest",
): Promise<{ secret: string; grantId: Id<"uploadGrants"> }> {
  const result = await f.t
    .withIdentity({ subject })
    .mutation(api.media.requestUploadGrant, grantArgs(f.eventId, over));
  if (result.outcome !== "granted") {
    throw new Error(`expected a grant, got ${result.outcome}`);
  }
  return { secret: result.secret, grantId: result.grantId };
}

function completionArgs(secret: string, over: Record<string, unknown> = {}) {
  return {
    callbackSecret: CALLBACK_SECRET,
    secret,
    fileKey: FILE_KEY,
    byteSize: 2048,
    ...over,
  };
}

beforeEach(() => {
  setCallbackSecret(CALLBACK_SECRET);
  useFakeStorage();
});

afterEach(() => {
  setCallbackSecret(undefined);
  clearFakeStorage();
});

/* -------------------------------------------------------------------------- */
/* Issuing a grant                                                            */
/* -------------------------------------------------------------------------- */

describe("media.requestUploadGrant", () => {
  it("issues a bound, short-lived, single-use grant to a member of a live event", async () => {
    const f = await fixture();
    const before = Date.now();
    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId));

    expect(result).toMatchObject({
      outcome: "granted",
      eventId: f.eventId,
      captureId: CAPTURE,
      mediaType: "photo",
      mediaSource: "capture",
      storageRegion: "pdx1",
      byteSize: 2048,
      maxBytes: PHOTO_MAX_BYTES,
    });
    if (result.outcome !== "granted") throw new Error("unreachable");

    expect(result.expiresAt).toBeGreaterThanOrEqual(before + GRANT_POLICY.ttlMs);
    expect(result.secret.length).toBeGreaterThanOrEqual(16);

    const row = await f.t.run(async (ctx) => ctx.db.get(result.grantId));
    expect(row?.status).toBe("issued");
    // The capability itself is never persisted — only a digest of it.
    expect(JSON.stringify(row)).not.toContain(result.secret);
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.checksum).toBe(CHECKSUM);
    expect(row?.storageRegion).toBe("pdx1");
  });

  it("audits the issue without recording the secret or the checksum", async () => {
    const f = await fixture();
    await grant(f);

    const rows = await f.t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    const granted = rows.find((row) => row.action === AUDIT_ACTIONS.uploadGranted);
    expect(granted).toBeDefined();
    expect(granted?.eventId).toBe(f.eventId);
    expect(granted?.metadata).toMatchObject({ captureId: CAPTURE, mediaType: "photo" });
    expect(JSON.stringify(granted?.metadata)).not.toContain(CHECKSUM);
  });

  it("refuses a stranger with notFound rather than forbidden", async () => {
    const f = await fixture();
    await seedUser(f.t, { authId: "stranger", email: "stranger@partybooth.test" });
    await expect(
      f.t
        .withIdentity({ subject: "stranger" })
        .mutation(api.media.requestUploadGrant, grantArgs(f.eventId)),
    ).rejects.toThrow(/could not be found/i);
  });

  it("refuses an unauthenticated caller", async () => {
    const f = await fixture();
    await expect(
      f.t.mutation(api.media.requestUploadGrant, grantArgs(f.eventId)),
    ).rejects.toThrow();
  });

  it.each(["draft", "scheduled", "paused", "archived"] as const)(
    "refuses uploads while the event is %s",
    async (state) => {
      const f = await fixture({ state });
      const result = await f.t
        .withIdentity({ subject: "guest" })
        .mutation(api.media.requestUploadGrant, grantArgs(f.eventId));
      expect(result).toMatchObject({ outcome: "rejected", reason: "eventNotAcceptingUploads" });
    },
  );

  /* ---- size caps ---- */

  it("rejects a photo over the 20 MB cap and accepts one exactly on it", async () => {
    const f = await fixture();
    const as = f.t.withIdentity({ subject: "guest" });

    const tooBig = await as.mutation(
      api.media.requestUploadGrant,
      grantArgs(f.eventId, { byteSize: PHOTO_MAX_BYTES + 1 }),
    );
    expect(tooBig).toMatchObject({ outcome: "rejected", reason: "tooLarge" });

    const exact = await as.mutation(
      api.media.requestUploadGrant,
      grantArgs(f.eventId, { captureId: "capture-00000002", byteSize: PHOTO_MAX_BYTES }),
    );
    expect(exact.outcome).toBe("granted");
  });

  it("accepts video at the pipeline level even though capture is Sprint 4", async () => {
    const f = await fixture();
    const result = await f.t.withIdentity({ subject: "guest" }).mutation(
      api.media.requestUploadGrant,
      grantArgs(f.eventId, {
        mediaType: "video",
        mimeType: "video/mp4",
        byteSize: 50_000_000,
        durationSeconds: 42,
      }),
    );
    expect(result).toMatchObject({ outcome: "granted", mediaType: "video" });
  });

  it("rejects a video longer than sixty seconds and one with no duration at all", async () => {
    const f = await fixture();
    const as = f.t.withIdentity({ subject: "guest" });

    // Both are refused at the argument edge by `uploadGrantRequestSchema`, which
    // is deliberately stricter than the domain gate: a duration outside the
    // sixty-second envelope is a malformed request, not a business decision.
    // `checkGrantEligibility`'s `tooLong` is what a *client* uses to say so
    // before it wastes the guest's bandwidth getting here.
    await expect(
      as.mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, {
          mediaType: "video",
          mimeType: "video/mp4",
          byteSize: 1_000,
          durationSeconds: 61,
        }),
      ),
    ).rejects.toThrow(/duration/i);

    await expect(
      as.mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, { mediaType: "video", mimeType: "video/mp4", byteSize: 1_000 }),
      ),
    ).rejects.toThrow(/durationSeconds/i);
  });

  /* ---- library import flag ---- */

  it("refuses a library import when the host has turned imports off", async () => {
    const f = await fixture({ allowLibraryImport: false });
    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId, { mediaSource: "library" }));
    expect(result).toMatchObject({ outcome: "rejected", reason: "libraryImportDisabled" });

    expect(await auditActions(f.t)).toContain(AUDIT_ACTIONS.uploadRejected);
  });

  it("still allows a camera capture when imports are off", async () => {
    const f = await fixture({ allowLibraryImport: false });
    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId, { mediaSource: "capture" }));
    expect(result.outcome).toBe("granted");
  });

  it("allows a library import when the host has turned imports on", async () => {
    const f = await fixture({ allowLibraryImport: true });
    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId, { fromLibrary: true }));
    expect(result).toMatchObject({ outcome: "granted", mediaSource: "library" });
  });

  /* ---- duplicates ---- */

  it("refuses a second grant for a capture that already has a stored file", async () => {
    const f = await fixture();
    const { secret } = await grant(f);
    await f.t.mutation(api.media.completeUpload, completionArgs(secret));

    const again = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId));
    expect(again).toMatchObject({ outcome: "rejected", reason: "duplicateCapture" });
  });

  it("will not let one guest claim another guest's captureId", async () => {
    // `captureId` is client-generated and the index is scoped to the event, not
    // to the person, so two guests at one party can propose the same id. Whoever
    // got there first keeps it — otherwise the resume path below is a hijack:
    // B's photo would land on A's row, in A's list, withdrawable only by A.
    const f = await fixture();
    await grant(f); // guest, CAPTURE
    await f.t.withIdentity({ subject: "guest" }).mutation(api.media.confirmUpload, {
      secret: (await grant(f, { captureId: "capture-aaaaaaaa" })).secret,
    });

    const stranded = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, { captureId: "capture-bbbb1111" }),
      );
    expect(stranded.outcome).toBe("granted");
    if (stranded.outcome !== "granted") throw new Error("unreachable");
    await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.confirmUpload, { secret: stranded.secret });

    const hijack = await f.t
      .withIdentity({ subject: "other" })
      .mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, { captureId: "capture-bbbb1111" }),
      );
    expect(hijack).toMatchObject({ outcome: "rejected", reason: "duplicateCapture" });

    const rows = await f.t.run(async (ctx) => ctx.db.query("media").collect());
    for (const row of rows) expect(row.uploaderUserId).toBe(f.guestId);
  });

  it("lets a capture whose grant expired mid-upload try again", async () => {
    // Otherwise a dropped connection strands the photo on the guest's phone.
    const f = await fixture();
    const { secret } = await grant(f);
    await f.t.withIdentity({ subject: "guest" }).mutation(api.media.confirmUpload, { secret });

    const again = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId));
    expect(again.outcome).toBe("granted");
  });

  /* ---- throttle ---- */

  it("throttles an account past the per-window ceiling and charges nothing else", async () => {
    const f = await fixture();
    const as = f.t.withIdentity({ subject: "guest" });

    for (let i = 0; i < GRANT_POLICY.maxPerWindow; i += 1) {
      const result = await as.mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, { captureId: `capture-${String(i).padStart(8, "0")}` }),
      );
      expect(result.outcome).toBe("granted");
    }

    const throttled = await as.mutation(
      api.media.requestUploadGrant,
      grantArgs(f.eventId, { captureId: "capture-99999999" }),
    );
    expect(throttled.outcome).toBe("throttled");
    if (throttled.outcome !== "throttled") throw new Error("unreachable");
    expect(throttled.retryAfterMs).toBeGreaterThan(0);

    // The counter is a real row, not something held in an isolate.
    const rows = await f.t.run(async (ctx) => ctx.db.query("uploadAttempts").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issuedCount).toBe(GRANT_POLICY.maxPerWindow);
  });

  it("throttles per account, not per event", async () => {
    const f = await fixture();
    const as = f.t.withIdentity({ subject: "guest" });
    for (let i = 0; i < GRANT_POLICY.maxPerWindow; i += 1) {
      await as.mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, { captureId: `capture-${String(i).padStart(8, "0")}` }),
      );
    }

    // A different guest at the same party is unaffected.
    const other = await f.t
      .withIdentity({ subject: "other" })
      .mutation(
        api.media.requestUploadGrant,
        grantArgs(f.eventId, { captureId: "capture-other1" }),
      );
    expect(other.outcome).toBe("granted");
  });
});

/* -------------------------------------------------------------------------- */
/* Consuming a grant                                                          */
/* -------------------------------------------------------------------------- */

describe("grant consumption", () => {
  it("spends a grant exactly once", async () => {
    const f = await fixture();
    const { secret, grantId } = await grant(f);

    const first = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(first.outcome).toBe("registered");

    const row = await f.t.run(async (ctx) => ctx.db.get(grantId));
    expect(row?.status).toBe("consumed");
    expect(row?.consumedFileKey).toBe(FILE_KEY);
    expect(row?.mediaId).toBeDefined();
  });

  it("refuses a grant whose two minutes ran out, and deletes the late file", async () => {
    const f = await fixture();
    const { secret, grantId } = await grant(f);

    await f.t.run(async (ctx) => {
      await ctx.db.patch(grantId, { expiresAt: Date.now() - 1 });
    });

    const storage = useFakeStorage();
    storage.put(FILE_KEY);

    const result = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(result).toMatchObject({ outcome: "discarded", reason: "expired" });

    // The status is tidied on the way past, and nothing was created.
    const row = await f.t.run(async (ctx) => ctx.db.get(grantId));
    expect(row?.status).toBe("expired");
    const media = await f.t.run(async (ctx) => ctx.db.query("media").collect());
    expect(media).toHaveLength(0);

    // A mutation has no network, so the delete is scheduled. Draining it is
    // what makes "the bytes are gone" assertable.
    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(false);
  });

  it("refuses a completion whose body is not the size that was granted", async () => {
    const f = await fixture();
    const { secret, grantId } = await grant(f);
    const storage = useFakeStorage();
    storage.put("swapped-key");

    const result = await f.t.mutation(
      api.media.completeUpload,
      completionArgs(secret, { fileKey: "swapped-key", byteSize: 999_999 }),
    );
    expect(result).toMatchObject({ outcome: "discarded", reason: "byteSize" });

    // The grant is burned even though the upload was refused: a swap attempt
    // must not leave a re-usable capability behind.
    const row = await f.t.run(async (ctx) => ctx.db.get(grantId));
    expect(row?.status).toBe("consumed");
    await runScheduled(f.t);
    expect(storage.has("swapped-key")).toBe(false);
    expect(await auditActions(f.t)).toContain(AUDIT_ACTIONS.uploadDiscarded);
  });

  it("refuses a completion whose checksum does not match the grant", async () => {
    const f = await fixture();
    const { secret } = await grant(f);
    const result = await f.t.mutation(
      api.media.completeUpload,
      completionArgs(secret, { checksum: "b".repeat(64) }),
    );
    expect(result).toMatchObject({ outcome: "discarded", reason: "checksum" });
  });

  it("says nothing useful about a secret it does not recognise", async () => {
    const f = await fixture();
    const result = await f.t.mutation(api.media.completeUpload, completionArgs("Z".repeat(40)));
    expect(result).toMatchObject({ outcome: "rejected", reason: "unknownGrant" });
  });

  it("refuses the completion callback without the shared secret", async () => {
    const f = await fixture();
    const { secret } = await grant(f);

    await expect(
      f.t.mutation(api.media.completeUpload, completionArgs(secret, { callbackSecret: "wrong" })),
    ).rejects.toThrow(/not callable from a client/i);

    // And with no secret configured at all, so an unconfigured deployment fails
    // closed rather than accepting anything a guest sends.
    setCallbackSecret(undefined);
    await expect(f.t.mutation(api.media.completeUpload, completionArgs(secret))).rejects.toThrow(
      /not callable from a client/i,
    );
  });

  it("will not let one guest confirm another guest's grant", async () => {
    const f = await fixture();
    const { secret } = await grant(f);
    await expect(
      f.t.withIdentity({ subject: "other" }).mutation(api.media.confirmUpload, { secret }),
    ).rejects.toThrow(/could not be found/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotency — both orders, and duplicates of each                          */
/* -------------------------------------------------------------------------- */

describe("completion idempotency", () => {
  async function mediaRows(f: Fixture) {
    return await f.t.run(async (ctx) => ctx.db.query("media").collect());
  }

  it("callback then client confirmation produces exactly one row", async () => {
    const f = await fixture();
    const { secret } = await grant(f);

    const completed = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(completed).toMatchObject({ outcome: "registered", state: "pending" });

    const confirmed = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.confirmUpload, { secret });
    expect(confirmed).toMatchObject({ mediaId: completed.mediaId, state: "pending" });

    expect(await mediaRows(f)).toHaveLength(1);
  });

  it("client confirmation then callback produces exactly one row", async () => {
    const f = await fixture();
    const { secret } = await grant(f);

    const confirmed = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.confirmUpload, { secret });
    expect(confirmed).toMatchObject({ state: "processing" });

    const completed = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(completed).toMatchObject({
      outcome: "registered",
      mediaId: confirmed.mediaId,
      state: "pending",
    });

    const rows = await mediaRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.storageKey).toBe(FILE_KEY);
  });

  it("a duplicate callback changes nothing", async () => {
    const f = await fixture();
    const { secret } = await grant(f);

    const first = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    const second = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    const third = await f.t.mutation(api.media.completeUpload, completionArgs(secret));

    expect(second).toMatchObject({ outcome: "duplicate", mediaId: first.mediaId });
    expect(third).toMatchObject({ outcome: "duplicate", mediaId: first.mediaId });
    expect(await mediaRows(f)).toHaveLength(1);

    // One audited completion, not three — a provider retry storm must not drown
    // the log it is supposed to explain.
    const completions = (await auditActions(f.t)).filter(
      (action) => action === AUDIT_ACTIONS.uploadCompleted,
    );
    expect(completions).toHaveLength(1);
  });

  it("a duplicate confirmation changes nothing", async () => {
    const f = await fixture();
    const { secret } = await grant(f);
    const as = f.t.withIdentity({ subject: "guest" });

    const first = await as.mutation(api.media.confirmUpload, { secret });
    const second = await as.mutation(api.media.confirmUpload, { secret });
    expect(second.mediaId).toBe(first.mediaId);
    expect(await mediaRows(f)).toHaveLength(1);
  });

  it("deletes a second, different file smuggled in against one grant", async () => {
    const f = await fixture();
    const { secret } = await grant(f);
    const storage = useFakeStorage();
    storage.put(FILE_KEY);
    storage.put("second-file");

    await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    const second = await f.t.mutation(
      api.media.completeUpload,
      completionArgs(secret, { fileKey: "second-file" }),
    );

    expect(second).toMatchObject({ outcome: "discarded", reason: "duplicateFile" });
    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(true);
    expect(storage.has("second-file")).toBe(false);
    expect(await mediaRows(f)).toHaveLength(1);
  });

  it("does not create a row for a confirmation that arrives after the grant expired", async () => {
    const f = await fixture();
    const { secret, grantId } = await grant(f);
    await f.t.run(async (ctx) => ctx.db.patch(grantId, { expiresAt: Date.now() - 1 }));

    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.confirmUpload, { secret });
    expect(result).toEqual({ mediaId: null, state: null });
    expect(await mediaRows(f)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The media state machine, per moderation mode                               */
/* -------------------------------------------------------------------------- */

describe("media state after processing", () => {
  it("lands in pending under manual moderation", async () => {
    const f = await fixture({ moderationMode: "manual" });
    const { secret } = await grant(f);
    const result = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(result.state).toBe("pending");

    const event = await f.t.run(async (ctx) => ctx.db.get(f.eventId));
    expect(event?.counts).toMatchObject({ pending: 1, approved: 0, declined: 0, total: 1 });
  });

  it("lands in approved under automatic moderation", async () => {
    const f = await fixture({ moderationMode: "automatic" });
    const { secret } = await grant(f);
    const result = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(result.state).toBe("approved");

    const event = await f.t.run(async (ctx) => ctx.db.get(f.eventId));
    expect(event?.counts).toMatchObject({ pending: 0, approved: 1, total: 1 });
  });

  it("queues for a human under ai mode, because the classifier is post-launch", async () => {
    const f = await fixture({ moderationMode: "ai" });
    const { secret } = await grant(f);
    const result = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(result.state).toBe("pending");
  });

  it("keeps a still-processing item out of the pending badge", async () => {
    const f = await fixture();
    const { secret } = await grant(f);
    await f.t.withIdentity({ subject: "guest" }).mutation(api.media.confirmUpload, { secret });

    const event = await f.t.run(async (ctx) => ctx.db.get(f.eventId));
    // In `total` (it is a real submission) but not yet in `pending`: the host's
    // badge must not blink for a photo that is still uploading.
    expect(event?.counts).toMatchObject({ pending: 0, total: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* Withdrawal                                                                 */
/* -------------------------------------------------------------------------- */

describe("media.withdraw", () => {
  it("tombstones the record, deletes the file and is permanent", async () => {
    const f = await fixture();
    const storage = useFakeStorage();
    const { secret } = await grant(f);
    storage.put(FILE_KEY);
    const completed = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    const mediaId = completed.mediaId as Id<"media">;

    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.withdraw, { mediaId });
    expect(result).toEqual({ state: "deleted" });

    const row = await f.t.run(async (ctx) => ctx.db.get(mediaId));
    expect(row?.state).toBe("deleted");
    expect(row?.withdrawnAt).toBeDefined();
    expect(row?.deletedAt).toBeDefined();

    // The bytes are gone and the record no longer names an object, so nothing
    // left on it can mint a signed URL.
    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(false);
    const purged = await f.t.run(async (ctx) => ctx.db.get(mediaId));
    expect(purged?.storageKey).toBeUndefined();
    expect(purged?.storageDeletedAt).toBeDefined();

    // Terminal: nothing moves it back.
    await expect(
      f.t.withIdentity({ subject: "guest" }).mutation(api.media.withdraw, { mediaId }),
    ).rejects.toThrow();

    const event = await f.t.run(async (ctx) => ctx.db.get(f.eventId));
    expect(event?.counts).toMatchObject({ pending: 0, total: 0 });
    expect(await auditActions(f.t)).toContain(AUDIT_ACTIONS.mediaWithdrawn);
  });

  it("works from every state a submitter can be looking at", async () => {
    for (const state of ["processing", "pending", "approved", "declined"] as const) {
      const f = await fixture();
      useFakeStorage();
      const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state });
      const result = await f.t
        .withIdentity({ subject: "guest" })
        .mutation(api.media.withdraw, { mediaId });
      expect(result, `withdrawing from ${state}`).toEqual({ state: "deleted" });
      await runScheduled(f.t);
    }
  });

  it("refuses anyone but the submitter — including the host", async () => {
    const f = await fixture();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });

    // A host wanting somebody else's photo gone uses `media.delete`, which is a
    // different action with a different audit row.
    await expect(
      f.t.withIdentity({ subject: "other" }).mutation(api.media.withdraw, { mediaId }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      f.t.withIdentity({ subject: "owner" }).mutation(api.media.withdraw, { mediaId }),
    ).rejects.toThrow(/forbidden/i);

    const row = await f.t.run(async (ctx) => ctx.db.get(mediaId));
    expect(row?.state).toBe("pending");
  });

  it("retires an unspent grant so an upload in flight cannot complete", async () => {
    const f = await fixture();
    const storage = useFakeStorage();
    const { secret, grantId } = await grant(f);
    const confirmed = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.confirmUpload, { secret });

    await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.withdraw, { mediaId: confirmed.mediaId as Id<"media"> });

    expect((await f.t.run(async (ctx) => ctx.db.get(grantId)))?.status).toBe("expired");

    // …and the callback that was already in flight deletes its own bytes rather
    // than attaching them to a row the guest has taken back.
    storage.put(FILE_KEY);
    const late = await f.t.mutation(api.media.completeUpload, completionArgs(secret));
    expect(late.outcome).toBe("discarded");
    await runScheduled(f.t);
    expect(storage.has(FILE_KEY)).toBe(false);

    const rows = await f.t.run(async (ctx) => ctx.db.query("media").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("deleted");
  });

  it("refuses a capture id that was withdrawn, rather than reviving it", async () => {
    const f = await fixture();
    useFakeStorage();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, {
      state: "pending",
      captureId: CAPTURE,
    });
    await f.t.withIdentity({ subject: "guest" }).mutation(api.media.withdraw, { mediaId });
    await runScheduled(f.t);

    const again = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, grantArgs(f.eventId));
    expect(again).toMatchObject({ outcome: "rejected", reason: "captureWithdrawn" });
  });
});

/* -------------------------------------------------------------------------- */
/* Read paths                                                                 */
/* -------------------------------------------------------------------------- */

describe("read paths", () => {
  it("gives a guest their own media in every state, with a short-lived URL", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending", storageKey: "k-pending" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "declined", storageKey: "k-declined" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "approved", storageKey: "k-other" });

    const mine = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.myMedia, { eventId: f.eventId });

    expect(mine.map((item) => item.state).sort()).toEqual(["declined", "pending"]);
    for (const item of mine) {
      expect(item.isOwn).toBe(true);
      expect(item.url).toMatch(/^https:\/\/fake\.ufs\.test\//);
      expect(item.urlExpiresAt).toBeGreaterThan(Date.now());
      // Never a raw key.
      expect(Object.keys(item)).not.toContain("storageKey");
      expect(item.url).not.toContain("k-other");
    }
  });

  it("shows a guest only approved media from other people", async () => {
    const f = await fixture();
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "pending" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "declined" });
    await seedMedia(f.t, f.eventId, f.otherGuestId, { state: "processing" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });

    const seen = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.eventMedia, { eventId: f.eventId });

    // Their own pending item, and one approved item from someone else.
    expect(seen).toHaveLength(2);
    for (const item of seen) {
      expect(item.isOwn || item.state === "approved").toBe(true);
    }
  });

  it.each(["owner", "cohost"] as const)("shows %s everything except deleted", async (role) => {
    const f = await fixture();
    const hostSubject = role === "owner" ? "owner" : "cohost";
    if (role === "cohost") {
      const cohostId = await seedUser(f.t, { authId: "cohost", email: "cohost@partybooth.test" });
      await seedMembership(f.t, f.eventId, cohostId, "cohost");
    }

    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "declined" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "processing" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "deleted" });

    const seen = await f.t
      .withIdentity({ subject: hostSubject })
      .query(api.media.eventMedia, { eventId: f.eventId });

    expect(seen.map((item) => item.state).sort()).toEqual([
      "approved",
      "declined",
      "pending",
      "processing",
    ]);
  });

  it("never leaks across events", async () => {
    const f = await fixture();
    const otherEventId = await seedEvent(f.t, f.ownerId, { state: "live", name: "Other party" });
    await seedMedia(f.t, otherEventId, f.ownerId, { state: "approved" });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });

    const seen = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.eventId).toBe(f.eventId);

    // …and the other party is not even visible to ask about.
    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.media.eventMedia, { eventId: otherEventId }),
    ).rejects.toThrow(/could not be found/i);
    await expect(
      f.t.withIdentity({ subject: "guest" }).query(api.media.myMedia, { eventId: otherEventId }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("never shows a withdrawn item to anyone, submitter included", async () => {
    const f = await fixture();
    useFakeStorage();
    const mediaId = await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });
    await f.t.withIdentity({ subject: "guest" }).mutation(api.media.withdraw, { mediaId });
    await runScheduled(f.t);

    expect(
      await f.t.withIdentity({ subject: "guest" }).query(api.media.myMedia, { eventId: f.eventId }),
    ).toHaveLength(0);
    expect(
      await f.t
        .withIdentity({ subject: "owner" })
        .query(api.media.eventMedia, { eventId: f.eventId }),
    ).toHaveLength(0);
    expect(
      await f.t
        .withIdentity({ subject: "owner" })
        .query(api.media.eventMedia, { eventId: f.eventId, states: ["deleted"] }),
    ).toHaveLength(0);
  });

  it("renders the list without URLs rather than failing when storage is unreachable", async () => {
    const f = await fixture();
    useFakeStorage({ failReads: true });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "pending" });

    const mine = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.myMedia, { eventId: f.eventId });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.url).toBeUndefined();
    expect(mine[0]?.state).toBe("pending");
  });

  it("refuses a global admin, who has no media capability at all", async () => {
    const f = await fixture();
    await seedUser(f.t, { authId: "admin", email: "admin@partybooth.test", isGlobalAdmin: true });
    await seedMedia(f.t, f.eventId, f.guestId, { state: "approved" });

    // No membership, so the event is not even acknowledged.
    await expect(
      f.t.withIdentity({ subject: "admin" }).query(api.media.eventMedia, { eventId: f.eventId }),
    ).rejects.toThrow();
  });
});
