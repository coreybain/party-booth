import { describe, expect, it } from "vitest";

import {
  compareChronological,
  decodeMediaCursor,
  DERIVATIVE_LIMITS,
  derivativeRolesFor,
  encodeMediaCursor,
  isAfterCursor,
  isDerivativeRole,
  isFileRoleAllowed,
  maxBytesForRole,
  MEDIA_FILE_ROLES,
  MEDIA_STATES,
  MODERATION_ACTIONS,
  moderationTransition,
  PHOTO_MAX_BYTES,
  validateMediaFile,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  type MediaState,
} from "./media";
import {
  checkGrantEligibility,
  checkTicketAgainstGrant,
  fileRoleOf,
  grantSizeCap,
  isPermanentRejection,
} from "./upload";

const MIB = 1024 * 1024;

const LIVE_EVENT = { state: "live", allowLibraryImport: true } as const;

/* -------------------------------------------------------------------------- */
/* File roles                                                                 */
/* -------------------------------------------------------------------------- */

describe("file roles", () => {
  it("gives a photo a preview and a video a poster as well", () => {
    expect(derivativeRolesFor("photo")).toEqual(["preview"]);
    expect(derivativeRolesFor("video")).toEqual(["poster", "preview"]);
  });

  it("refuses a poster for a photo — there is no still to lift", () => {
    expect(isFileRoleAllowed("photo", "poster")).toBe(false);
    expect(isFileRoleAllowed("video", "poster")).toBe(true);
  });

  it("treats everything that is not the submitted frame as a derivative", () => {
    expect(MEDIA_FILE_ROLES.filter(isDerivativeRole)).toEqual(["preview", "poster"]);
  });

  it("reads an absent role as the original, so Sprint 3 rows still parse", () => {
    expect(fileRoleOf({})).toBe("original");
    expect(fileRoleOf({ fileRole: undefined })).toBe("original");
    expect(fileRoleOf({ fileRole: "preview" })).toBe("preview");
  });
});

describe("per-role caps", () => {
  it("holds a preview to megabytes where the original gets tens of them", () => {
    expect(maxBytesForRole("photo", "original")).toBe(PHOTO_MAX_BYTES);
    expect(maxBytesForRole("photo", "preview")).toBe(DERIVATIVE_LIMITS.image.maxBytes);
    expect(maxBytesForRole("photo", "preview")).toBeLessThan(PHOTO_MAX_BYTES);
  });

  it("gives a video's preview clip room and its poster none", () => {
    expect(maxBytesForRole("video", "original")).toBe(VIDEO_MAX_BYTES);
    expect(maxBytesForRole("video", "preview")).toBe(DERIVATIVE_LIMITS.videoPreview.maxBytes);
    expect(maxBytesForRole("video", "poster")).toBe(DERIVATIVE_LIMITS.image.maxBytes);
  });

  it("reports the cap for the role, not for the type", () => {
    expect(grantSizeCap("photo")).toBe(PHOTO_MAX_BYTES);
    expect(grantSizeCap("photo", "preview")).toBe(DERIVATIVE_LIMITS.image.maxBytes);
  });
});

describe("validateMediaFile with a role", () => {
  it("refuses a 3 MB 'preview' that would pass as a photo", () => {
    const asOriginal = validateMediaFile({
      mediaType: "photo",
      byteSize: 3 * MIB,
      mimeType: "image/jpeg",
    });
    expect(asOriginal.ok).toBe(true);

    const asPreview = validateMediaFile({
      mediaType: "photo",
      fileRole: "preview",
      byteSize: 3 * MIB,
      mimeType: "image/jpeg",
    });
    expect(asPreview).toMatchObject({ ok: false, reason: "tooLarge" });
  });

  it("refuses a poster for a photo", () => {
    expect(
      validateMediaFile({
        mediaType: "photo",
        fileRole: "poster",
        byteSize: 1000,
        mimeType: "image/jpeg",
      }),
    ).toMatchObject({ ok: false, reason: "unsupportedFileRole" });
  });

  it("does not demand a duration for a video poster, which is a still", () => {
    expect(
      validateMediaFile({
        mediaType: "video",
        fileRole: "poster",
        byteSize: 50_000,
        mimeType: "image/jpeg",
      }),
    ).toEqual({ ok: true });
  });

  it("still demands one for a video's original and its preview clip", () => {
    for (const fileRole of ["original", "preview"] as const) {
      expect(
        validateMediaFile({
          mediaType: "video",
          fileRole,
          byteSize: 50_000,
          mimeType: "video/mp4",
        }),
      ).toMatchObject({ ok: false, reason: "missingDuration" });
    }
  });

  it("holds a video preview clip to the same sixty seconds", () => {
    expect(
      validateMediaFile({
        mediaType: "video",
        fileRole: "preview",
        byteSize: 50_000,
        mimeType: "video/mp4",
        durationSeconds: VIDEO_MAX_DURATION_SECONDS + 1,
      }),
    ).toMatchObject({ ok: false, reason: "tooLong" });
  });

  it("refuses an mp4 offered as a photo's preview", () => {
    expect(
      validateMediaFile({
        mediaType: "photo",
        fileRole: "preview",
        byteSize: 50_000,
        mimeType: "video/mp4",
      }),
    ).toMatchObject({ ok: false, reason: "unsupportedMimeType" });
  });
});

/* -------------------------------------------------------------------------- */
/* Grant eligibility for derivatives                                          */
/* -------------------------------------------------------------------------- */

describe("checkGrantEligibility for a derivative", () => {
  const previewFile = {
    mediaType: "photo",
    fileRole: "preview",
    byteSize: 40_000,
    mimeType: "image/jpeg",
  } as const;

  it("requires the re-encode claim, because this is what third parties see", () => {
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: previewFile,
      }),
    ).toMatchObject({ ok: false, reason: "derivativeMetadataNotStripped" });

    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: previewFile,
        sourceMetadataStripped: false,
      }),
    ).toMatchObject({ ok: false, reason: "derivativeMetadataNotStripped" });
  });

  it("accepts one that claims it", () => {
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: previewFile,
        sourceMetadataStripped: true,
      }),
    ).toEqual({ ok: true });
  });

  it("leaves the original's claim optional — that one is recorded, not required", () => {
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: { mediaType: "photo", byteSize: 40_000, mimeType: "image/jpeg" },
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a paused party before it looks at the file at all", () => {
    expect(
      checkGrantEligibility({
        event: { state: "paused", allowLibraryImport: true },
        mediaSource: "capture",
        file: previewFile,
      }),
    ).toMatchObject({ ok: false, reason: "eventNotAcceptingUploads" });
  });
});

describe("which derivative refusals a client should retry", () => {
  it("keeps retrying a preview whose original grant is a moment behind", () => {
    // Clients fire the original and the preview off together. Making this
    // permanent would drop the preview of every capture that lost that race.
    expect(isPermanentRejection("derivativeWithoutOriginal")).toBe(false);
  });

  it("stops for the ones a retry cannot fix", () => {
    expect(isPermanentRejection("derivativeMetadataNotStripped")).toBe(true);
    expect(isPermanentRejection("duplicateDerivative")).toBe(true);
    expect(isPermanentRejection("unsupportedFileRole")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The ticket against the grant                                               */
/* -------------------------------------------------------------------------- */

describe("checkTicketAgainstGrant on the role", () => {
  const ticket = {
    mediaType: "photo",
    fileRole: "preview",
    byteSize: 40_000,
    mimeType: "image/jpeg",
  } as const;

  it("refuses a ticket that renames the role it was granted", () => {
    // The role selects the cap the edge applies. A 20 MB original relabelled as
    // a preview would be measured against 2 MB — and vice versa, which is the
    // direction that actually stores bytes.
    expect(
      checkTicketAgainstGrant(ticket, {
        mediaType: "photo",
        fileRole: "original",
        byteSize: 40_000,
        mimeType: "image/jpeg",
      }),
    ).toMatchObject({ ok: false, reason: "fileRole" });
  });

  it("accepts a matching one", () => {
    expect(
      checkTicketAgainstGrant(ticket, {
        mediaType: "photo",
        fileRole: "preview",
        byteSize: 40_000,
        mimeType: "image/jpeg",
      }),
    ).toEqual({ ok: true });
  });

  it("treats both absent roles as original, so an old client still passes", () => {
    expect(
      checkTicketAgainstGrant(
        { mediaType: "photo", byteSize: 40_000, mimeType: "image/jpeg" },
        { mediaType: "photo", byteSize: 40_000, mimeType: "image/jpeg" },
      ),
    ).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Moderation transitions                                                     */
/* -------------------------------------------------------------------------- */

describe("moderationTransition", () => {
  it("approves from pending and from declined", () => {
    for (const from of ["pending", "declined"] as const) {
      expect(moderationTransition("approve", from)).toMatchObject({
        ok: true,
        next: "approved",
        changed: true,
      });
    }
  });

  it("declines from pending and from approved", () => {
    for (const from of ["pending", "approved"] as const) {
      expect(moderationTransition("decline", from)).toMatchObject({
        ok: true,
        next: "declined",
        changed: true,
      });
    }
  });

  it("reports a repeat as unchanged rather than as an error", () => {
    // Two hosts double-tapping the same card at 1am is the common case. It must
    // not write a second decision row and must not fail the batch it is in.
    expect(moderationTransition("approve", "approved")).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(moderationTransition("decline", "declined")).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it("revokes only an approval", () => {
    expect(moderationTransition("revoke", "approved")).toMatchObject({
      ok: true,
      next: "declined",
      decision: "declined",
      changed: true,
    });
    for (const from of ["pending", "declined"] as const) {
      expect(moderationTransition("revoke", from)).toMatchObject({
        ok: false,
        reason: "notApproved",
      });
    }
  });

  it("refuses anything still uploading", () => {
    for (const action of MODERATION_ACTIONS) {
      expect(moderationTransition(action, "processing")).toMatchObject({
        ok: false,
        reason: "stillProcessing",
      });
    }
  });

  it("refuses anything withdrawn, in every direction", () => {
    for (const action of MODERATION_ACTIONS) {
      expect(moderationTransition(action, "deleted")).toMatchObject({
        ok: false,
        reason: "withdrawn",
      });
    }
  });

  it("never lands anywhere but approved or declined", () => {
    for (const action of MODERATION_ACTIONS) {
      for (const from of MEDIA_STATES) {
        const result = moderationTransition(action, from as MediaState);
        if (result.ok) expect(["approved", "declined"]).toContain(result.next);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Cursors                                                                    */
/* -------------------------------------------------------------------------- */

describe("media cursors", () => {
  it("round-trips", () => {
    const cursor = { createdAt: 1_800_000_000_000, id: "abc123" };
    expect(decodeMediaCursor(encodeMediaCursor(cursor))).toEqual(cursor);
  });

  it("treats anything that is not a cursor as 'start from the beginning'", () => {
    for (const value of [undefined, null, "", "nonsense", "abc:123", "1:", ":x", "1:a b"]) {
      expect(decodeMediaCursor(value)).toBeUndefined();
    }
  });

  it("breaks a same-millisecond tie by id, so nothing is skipped or repeated", () => {
    // Fifty phones firing at one party genuinely produce two rows in the same
    // millisecond, and a timestamp-only cursor either drops one or loops.
    const a = { createdAt: 100, id: "aaa" };
    const b = { createdAt: 100, id: "bbb" };
    expect(compareChronological(a, b)).toBeLessThan(0);
    expect(isAfterCursor(b, a)).toBe(true);
    expect(isAfterCursor(a, b)).toBe(false);
    expect(isAfterCursor(a, a)).toBe(false);
  });

  it("passes everything through when there is no cursor", () => {
    expect(isAfterCursor({ createdAt: 0, id: "a" }, undefined)).toBe(true);
  });
});
