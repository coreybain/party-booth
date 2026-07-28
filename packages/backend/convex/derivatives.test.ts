import {
  AUDIT_ACTIONS,
  DERIVATIVE_LIMITS,
  VIDEO_MAX_DURATION_SECONDS,
} from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  auditActions,
  CALLBACK_SECRET,
  clearFakeStorage,
  makeTest,
  runScheduled,
  seedEvent,
  seedMembership,
  seedUser,
  setCallbackSecret,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * Derivative ingestion — the Sprint 3 carry-over.
 *
 * The gap Sprint 3 left was that nothing ever wrote `previewKey` or `posterKey`,
 * so `mayServeOriginal`'s refusal branch served a fellow guest *nothing*. These
 * suites are about the three things that close it and the four that must not
 * break while it does:
 *
 * - a preview reaches the row it belongs to, whatever order the callbacks
 *   arrive in, and however many times each arrives;
 * - it does **not** move the state, the counters, or the submission count;
 * - a guest is served the derivative and never an unconfirmed original;
 * - and nobody can attach a preview to somebody else's capture.
 */

const CHECKSUM = "a".repeat(64);
const PREVIEW_CHECKSUM = "b".repeat(64);
const POSTER_CHECKSUM = "c".repeat(64);
const CAPTURE = "capture-00000001";

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

async function grant(
  f: Fixture,
  over: Record<string, unknown> = {},
  subject = "guest",
): Promise<{ secret: string; grantId: Id<"uploadGrants"> }> {
  const result = await f.t.withIdentity({ subject }).mutation(api.media.requestUploadGrant, {
    eventId: f.eventId,
    captureId: CAPTURE,
    mediaType: "photo" as const,
    byteSize: 2048,
    mimeType: "image/jpeg",
    checksum: CHECKSUM,
    ...over,
  });
  if (result.outcome !== "granted") {
    throw new Error(`expected a grant, got ${result.outcome}: ${JSON.stringify(result)}`);
  }
  return { secret: result.secret, grantId: result.grantId };
}

function previewArgs(over: Record<string, unknown> = {}) {
  return {
    fileRole: "preview" as const,
    byteSize: 40_000,
    mimeType: "image/jpeg",
    checksum: PREVIEW_CHECKSUM,
    sourceMetadataStripped: true,
    ...over,
  };
}

async function complete(f: Fixture, secret: string, over: Record<string, unknown> = {}) {
  return await f.t.mutation(api.media.completeUpload, {
    callbackSecret: CALLBACK_SECRET,
    secret,
    fileKey: "ut_original_0001",
    byteSize: 2048,
    ...over,
  });
}

const mediaRow = (f: Fixture) => f.t.run(async (ctx) => (await ctx.db.query("media").collect())[0]);

beforeEach(() => {
  setCallbackSecret(CALLBACK_SECRET);
  useFakeStorage();
});

afterEach(() => {
  setCallbackSecret(undefined);
  clearFakeStorage();
});

/* -------------------------------------------------------------------------- */
/* Issuing a derivative grant                                                 */
/* -------------------------------------------------------------------------- */

describe("requesting a derivative grant", () => {
  it("issues one alongside the original, under the same captureId", async () => {
    const f = await fixture();
    await grant(f);

    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs(),
      });

    expect(result).toMatchObject({
      outcome: "granted",
      captureId: CAPTURE,
      fileRole: "preview",
      maxBytes: DERIVATIVE_LIMITS.image.maxBytes,
    });
  });

  it("holds it to the preview cap, not the photo cap", async () => {
    const f = await fixture();
    await grant(f);

    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs({ byteSize: DERIVATIVE_LIMITS.image.maxBytes + 1 }),
      });

    expect(result).toMatchObject({ outcome: "rejected", reason: "tooLarge" });
  });

  it("refuses a preview that does not claim it was re-encoded", async () => {
    const f = await fixture();
    await grant(f);

    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs({ sourceMetadataStripped: undefined }),
      });

    // The derivative is what the whole gallery is served, so here the claim is a
    // precondition rather than a thing to record and read later.
    expect(result).toMatchObject({ outcome: "rejected", reason: "derivativeMetadataNotStripped" });
  });

  it("refuses a preview for a capture this account never asked to upload", async () => {
    const f = await fixture();
    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs(),
      });

    expect(result).toMatchObject({ outcome: "rejected", reason: "derivativeWithoutOriginal" });
  });

  it("refuses a preview against somebody else's capture", async () => {
    const f = await fixture();
    await grant(f);
    await complete(f, (await grant(f, {}, "guest")).secret).catch(() => undefined);

    // `other` names a captureId that belongs to `guest`.
    const result = await f.t
      .withIdentity({ subject: "other" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs(),
      });

    // Never `derivativeWithoutOriginal`, which would tell the caller that the
    // capture exists and belongs to somebody.
    expect(result).toMatchObject({ outcome: "rejected", reason: "duplicateCapture" });
  });

  it("refuses a poster for a photo", async () => {
    const f = await fixture();
    await grant(f);

    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs({ fileRole: "poster" }),
      });

    expect(result).toMatchObject({ outcome: "rejected", reason: "unsupportedFileRole" });
  });

  it("refuses a second preview once one has landed", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);

    const preview = await grant(f, previewArgs());
    await complete(f, preview.secret, { fileKey: "ut_preview_0001", byteSize: 40_000 });

    const again = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        mediaType: "photo",
        ...previewArgs({ checksum: "d".repeat(64) }),
      });

    expect(again).toMatchObject({ outcome: "rejected", reason: "duplicateDerivative" });
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciling roles at completion                                            */
/* -------------------------------------------------------------------------- */

describe("derivative completion", () => {
  it("attaches the preview to the row the original created", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);

    const preview = await grant(f, previewArgs());
    const result = await complete(f, preview.secret, {
      fileKey: "ut_preview_0001",
      byteSize: 40_000,
    });

    expect(result.outcome).toBe("registered");
    const row = await mediaRow(f);
    expect(row?.storageKey).toBe("ut_original_0001");
    expect(row?.previewKey).toBe("ut_preview_0001");
    expect(row?.previewByteSize).toBe(40_000);
  });

  it("leaves exactly one media row and one submission behind", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);
    const preview = await grant(f, previewArgs());
    await complete(f, preview.secret, { fileKey: "ut_preview_0001", byteSize: 40_000 });

    const rows = await f.t.run(async (ctx) => ctx.db.query("media").collect());
    expect(rows).toHaveLength(1);

    // A capture that arrives as three objects is still one submission. Counting
    // derivatives would treble every party and make the pending badge lie.
    const event = await f.t.run(async (ctx) => ctx.db.get(f.eventId));
    expect(event?.counts).toMatchObject({ pending: 1, total: 1 });
  });

  it("does not move the state — settling is the original's job", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);
    const before = (await mediaRow(f))?.state;

    const preview = await grant(f, previewArgs());
    await complete(f, preview.secret, { fileKey: "ut_preview_0001", byteSize: 40_000 });

    expect((await mediaRow(f))?.state).toBe(before);
  });

  it("is idempotent — the same callback twice changes nothing", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);
    const preview = await grant(f, previewArgs());

    const first = await complete(f, preview.secret, {
      fileKey: "ut_preview_0001",
      byteSize: 40_000,
    });
    const second = await complete(f, preview.secret, {
      fileKey: "ut_preview_0001",
      byteSize: 40_000,
    });

    expect(first.outcome).toBe("registered");
    expect(second.outcome).toBe("duplicate");
    expect((await mediaRow(f))?.previewKey).toBe("ut_preview_0001");

    const attached = (await auditActions(f.t)).filter(
      (action) => action === AUDIT_ACTIONS.derivativeAttached,
    );
    expect(attached).toHaveLength(1);
  });

  it("deletes a second, different preview rather than overwriting the first", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);

    // Two preview grants taken out before either completed — which a client
    // retrying a slow upload genuinely does — and then both spent.
    const preview = await grant(f, previewArgs());
    const second = await grant(f, previewArgs());
    await complete(f, preview.secret, { fileKey: "ut_preview_0001", byteSize: 40_000 });

    const fake = useFakeStorage();
    fake.put("ut_preview_0002", 40_000);
    const result = await complete(f, second.secret, {
      fileKey: "ut_preview_0002",
      byteSize: 40_000,
    });

    expect(result).toMatchObject({ outcome: "discarded", reason: "duplicateDerivative" });
    expect((await mediaRow(f))?.previewKey).toBe("ut_preview_0001");
    await runScheduled(f.t);
    expect(fake.has("ut_preview_0002")).toBe(false);
  });

  it("discards a preview that arrives before its original exists", async () => {
    const f = await fixture();
    await grant(f); // original granted, never completed
    const preview = await grant(f, previewArgs());

    const fake = useFakeStorage();
    fake.put("ut_preview_0001", 40_000);
    const result = await complete(f, preview.secret, {
      fileKey: "ut_preview_0001",
      byteSize: 40_000,
    });

    // Inventing a media row out of a thumbnail's byte size and checksum is the
    // one thing the reconciler must not do. The client retries.
    expect(result).toMatchObject({ outcome: "discarded", reason: "derivativeWithoutOriginal" });
    expect(await f.t.run(async (ctx) => ctx.db.query("media").collect())).toHaveLength(0);
    await runScheduled(f.t);
    expect(fake.has("ut_preview_0001")).toBe(false);
  });

  it("deletes a preview for a capture withdrawn while it was in flight", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);
    const preview = await grant(f, previewArgs());

    const row = await mediaRow(f);
    await f.t.withIdentity({ subject: "guest" }).mutation(api.media.withdraw, {
      mediaId: row!._id,
    });

    const fake = useFakeStorage();
    fake.put("ut_preview_0001", 40_000);
    const result = await complete(f, preview.secret, {
      fileKey: "ut_preview_0001",
      byteSize: 40_000,
    });

    expect(result.outcome).toBe("discarded");
    await runScheduled(f.t);
    expect(fake.has("ut_preview_0001")).toBe(false);
  });

  it("takes the derivatives with it when a capture is withdrawn", async () => {
    const f = await fixture();
    const fake = useFakeStorage();
    const original = await grant(f);
    await complete(f, original.secret);
    const preview = await grant(f, previewArgs());
    await complete(f, preview.secret, { fileKey: "ut_preview_0001", byteSize: 40_000 });

    const row = await mediaRow(f);
    await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.withdraw, { mediaId: row!._id });
    await runScheduled(f.t);

    // A withdrawn photo whose preview survived is a withdrawn photo the gallery
    // can still render.
    expect(fake.has("ut_original_0001")).toBe(false);
    expect(fake.has("ut_preview_0001")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Video: posters and the 60-second cap                                       */
/* -------------------------------------------------------------------------- */

describe("video", () => {
  const videoGrant = {
    mediaType: "video" as const,
    byteSize: 5_000_000,
    mimeType: "video/mp4",
    durationSeconds: 12,
  };

  it("takes a poster and a preview clip for one capture", async () => {
    const f = await fixture();
    const original = await grant(f, videoGrant);
    await complete(f, original.secret, { byteSize: 5_000_000, durationSeconds: 12 });

    const poster = await grant(f, {
      ...videoGrant,
      fileRole: "poster",
      byteSize: 30_000,
      mimeType: "image/jpeg",
      checksum: POSTER_CHECKSUM,
      durationSeconds: undefined,
      sourceMetadataStripped: true,
    });
    await complete(f, poster.secret, { fileKey: "ut_poster_0001", byteSize: 30_000 });

    const clip = await grant(f, {
      ...videoGrant,
      fileRole: "preview",
      byteSize: 900_000,
      checksum: PREVIEW_CHECKSUM,
      durationSeconds: 12,
      sourceMetadataStripped: true,
    });
    await complete(f, clip.secret, { fileKey: "ut_clip_0001", byteSize: 900_000 });

    const row = await mediaRow(f);
    expect(row?.posterKey).toBe("ut_poster_0001");
    expect(row?.previewKey).toBe("ut_clip_0001");
  });

  it("refuses an over-long video at the grant", async () => {
    const f = await fixture();
    // Refused by the input schema rather than by the domain gate: sixty seconds
    // is `uploadGrantRequestSchema`'s hard bound on the field, so an over-long
    // request cannot be *expressed*, let alone granted. `checkGrantEligibility`
    // still answers `tooLong` for the clients, which validate before they ask.
    await expect(
      f.t.withIdentity({ subject: "guest" }).mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        ...videoGrant,
        durationSeconds: VIDEO_MAX_DURATION_SECONDS + 1,
        checksum: CHECKSUM,
      }),
    ).rejects.toThrow(/durationSeconds/);
  });

  it("refuses an over-large video at the grant", async () => {
    const f = await fixture();
    const result = await f.t
      .withIdentity({ subject: "guest" })
      .mutation(api.media.requestUploadGrant, {
        eventId: f.eventId,
        captureId: CAPTURE,
        ...videoGrant,
        byteSize: 250 * 1024 * 1024 + 1,
        checksum: CHECKSUM,
      });
    expect(result).toMatchObject({ outcome: "rejected", reason: "tooLarge" });
  });

  it("discards a completion whose real duration overshot the cap", async () => {
    const f = await fixture();
    const fake = useFakeStorage();
    // Granted at 12 seconds — the estimate a client makes before the file
    // exists — and the object that landed is a minute and a half.
    const original = await grant(f, videoGrant);
    fake.put("ut_original_0001", 5_000_000);

    const result = await complete(f, original.secret, {
      byteSize: 5_000_000,
      durationSeconds: VIDEO_MAX_DURATION_SECONDS + 30,
    });

    expect(result).toMatchObject({ outcome: "discarded", reason: "tooLong" });
    expect(await f.t.run(async (ctx) => ctx.db.query("media").collect())).toHaveLength(0);
    await runScheduled(f.t);
    expect(fake.has("ut_original_0001")).toBe(false);
  });

  it("byteSize is still the binding a determined client cannot walk around", async () => {
    const f = await fixture();
    const original = await grant(f, videoGrant);
    const result = await complete(f, original.secret, {
      byteSize: 200_000_000,
      durationSeconds: 12,
    });
    expect(result).toMatchObject({ outcome: "discarded", reason: "byteSize" });
  });
});

/* -------------------------------------------------------------------------- */
/* What a guest is served                                                     */
/* -------------------------------------------------------------------------- */

describe("the mayServeOriginal seam, now that there is a derivative", () => {
  async function seedWithPreview(f: Fixture, stripped: boolean | undefined) {
    const original = await grant(f, {}, "guest");
    await complete(f, original.secret);
    const preview = await grant(f, previewArgs());
    await complete(f, preview.secret, { fileKey: "ut_preview_0001", byteSize: 40_000 });

    const row = await mediaRow(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(row!._id, {
        state: "approved",
        ...(stripped === undefined
          ? { sourceMetadataStripped: undefined }
          : { sourceMetadataStripped: stripped }),
      });
    });
  }

  it("serves the derivative to a fellow guest and withholds the original", async () => {
    const f = await fixture();
    await seedWithPreview(f, undefined);

    const [seen] = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });

    // The Sprint 3 note: this branch was "serve nothing" and becomes "serve the
    // derivative". Both halves are asserted, because half of it is the privacy
    // invariant and the other half is the feature.
    expect(seen?.url).toBeUndefined();
    expect(seen?.previewUrl).toMatch(/ut_preview_0001/);
  });

  it("still serves the original to its submitter and to the host", async () => {
    const f = await fixture();
    await seedWithPreview(f, undefined);

    const [own] = await f.t
      .withIdentity({ subject: "guest" })
      .query(api.media.myMedia, { eventId: f.eventId });
    expect(own?.url).toMatch(/ut_original_0001/);

    const [asHost] = await f.t
      .withIdentity({ subject: "owner" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(asHost?.url).toMatch(/ut_original_0001/);
  });

  it("serves both once the original claims the re-encode", async () => {
    const f = await fixture();
    await seedWithPreview(f, true);

    const [seen] = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(seen?.url).toMatch(/ut_original_0001/);
    expect(seen?.previewUrl).toMatch(/ut_preview_0001/);
  });

  it("still shows a fellow guest nothing when no preview has landed", async () => {
    const f = await fixture();
    const original = await grant(f);
    await complete(f, original.secret);
    const row = await mediaRow(f);
    await f.t.run(async (ctx) => ctx.db.patch(row!._id, { state: "approved" }));

    const [seen] = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    expect(seen?.url).toBeUndefined();
    expect(seen?.previewUrl).toBeUndefined();
  });

  it("never returns a file key on any read path", async () => {
    const f = await fixture();
    await seedWithPreview(f, true);
    const seen = await f.t
      .withIdentity({ subject: "other" })
      .query(api.media.eventMedia, { eventId: f.eventId });
    const json = JSON.stringify(seen);
    for (const field of ["storageKey", "previewKey", "posterKey"]) {
      expect(json).not.toContain(field);
    }
  });
});
