import { describe, expect, it } from "vitest";

import { MEDIA_STATES, PHOTO_MAX_BYTES, VIDEO_MAX_BYTES, canSeeMedia } from "./media";
import { ROLES } from "./roles";
import {
  accountGrantKey,
  buildUploadTicket,
  canIssueGrant,
  checkGrantEligibility,
  checkTicketAgainstFiles,
  grantExpiresAt,
  grantHasExpired,
  GRANT_POLICY,
  grantRejected,
  grantSizeCap,
  grantThrottled,
  isGrantUsable,
  isIssuedGrant,
  isPermanentRejection,
  matchesGrant,
  parseGrantResult,
  registerGrantIssued,
  TICKET_MISMATCH_MESSAGES,
  UPLOAD_REJECTION_MESSAGES,
  UPLOAD_REJECTION_REASONS,
  UPLOAD_ROUTE_PATH,
  UPLOAD_ROUTE_SLUG,
  uploadReasonForFile,
  uploadTicketSchema,
  type GrantAttemptState,
} from "./upload";

const NOW = 1_800_000_000_000;
const CHECKSUM = "a".repeat(64);

const LIVE_EVENT = { state: "live", allowLibraryImport: true } as const;

function photo(byteSize = 1_000): { mediaType: "photo"; byteSize: number } {
  return { mediaType: "photo", byteSize };
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

describe("checkGrantEligibility", () => {
  it("accepts a normal photo from a live event", () => {
    expect(
      checkGrantEligibility({ event: LIVE_EVENT, mediaSource: "capture", file: photo() }),
    ).toEqual({ ok: true });
  });

  it("accepts video even though the capture UI is Sprint 4", () => {
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: { mediaType: "video", byteSize: 10_000_000, durationSeconds: 30 },
      }),
    ).toEqual({ ok: true });
  });

  it.each(["draft", "scheduled", "paused", "archived", "deletionScheduled"] as const)(
    "refuses uploads while the event is %s",
    (state) => {
      const result = checkGrantEligibility({
        event: { state, allowLibraryImport: true },
        mediaSource: "capture",
        file: photo(),
      });
      expect(result).toMatchObject({ ok: false, reason: "eventNotAcceptingUploads" });
    },
  );

  it("refuses a library import when the host has turned imports off", () => {
    expect(
      checkGrantEligibility({
        event: { state: "live", allowLibraryImport: false },
        mediaSource: "library",
        file: photo(),
      }),
    ).toMatchObject({ ok: false, reason: "libraryImportDisabled" });
  });

  it("still accepts a camera capture when imports are off", () => {
    expect(
      checkGrantEligibility({
        event: { state: "live", allowLibraryImport: false },
        mediaSource: "capture",
        file: photo(),
      }),
    ).toEqual({ ok: true });
  });

  it("puts the event state ahead of the file complaint", () => {
    // A guest at a paused party is told the party is paused, not that their
    // 21 MB photo is too big — retrying smaller would not have helped.
    const result = checkGrantEligibility({
      event: { state: "paused", allowLibraryImport: false },
      mediaSource: "library",
      file: photo(PHOTO_MAX_BYTES + 1),
    });
    expect(result).toMatchObject({ ok: false, reason: "eventNotAcceptingUploads" });
  });

  it("puts the host's import setting ahead of the file complaint", () => {
    const result = checkGrantEligibility({
      event: { state: "live", allowLibraryImport: false },
      mediaSource: "library",
      file: photo(PHOTO_MAX_BYTES + 1),
    });
    expect(result).toMatchObject({ ok: false, reason: "libraryImportDisabled" });
  });

  it("enforces the photo cap at exactly the boundary", () => {
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: photo(PHOTO_MAX_BYTES),
      }),
    ).toEqual({ ok: true });
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: photo(PHOTO_MAX_BYTES + 1),
      }),
    ).toMatchObject({ ok: false, reason: "tooLarge", limit: PHOTO_MAX_BYTES });
  });

  it("enforces the video cap and duration independently", () => {
    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: { mediaType: "video", byteSize: VIDEO_MAX_BYTES + 1, durationSeconds: 10 },
      }),
    ).toMatchObject({ ok: false, reason: "tooLarge", limit: VIDEO_MAX_BYTES });

    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: { mediaType: "video", byteSize: 1_000, durationSeconds: 61 },
      }),
    ).toMatchObject({ ok: false, reason: "tooLong", limit: 60 });

    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: { mediaType: "video", byteSize: 1_000 },
      }),
    ).toMatchObject({ ok: false, reason: "missingDuration" });
  });

  it("rejects an empty file and an unsupported format", () => {
    expect(
      checkGrantEligibility({ event: LIVE_EVENT, mediaSource: "capture", file: photo(0) }),
    ).toMatchObject({ ok: false, reason: "emptyFile" });

    expect(
      checkGrantEligibility({
        event: LIVE_EVENT,
        mediaSource: "capture",
        file: { mediaType: "photo", byteSize: 10, mimeType: "image/gif" },
      }),
    ).toMatchObject({ ok: false, reason: "unsupportedMimeType" });
  });

  it("uses the per-type cap from the media contract", () => {
    expect(grantSizeCap("photo")).toBe(PHOTO_MAX_BYTES);
    expect(grantSizeCap("video")).toBe(VIDEO_MAX_BYTES);
  });

  it("has a message for every rejection reason", () => {
    for (const reason of UPLOAD_REJECTION_REASONS) {
      expect(UPLOAD_REJECTION_MESSAGES[reason].length).toBeGreaterThan(0);
    }
    expect(grantRejected("tooLarge")).toEqual({
      outcome: "rejected",
      reason: "tooLarge",
      message: UPLOAD_REJECTION_MESSAGES.tooLarge,
    });
  });

  it("passes a file reason straight through without a mapping table", () => {
    expect(uploadReasonForFile("tooLong")).toBe("tooLong");
  });
});

/* -------------------------------------------------------------------------- */
/* Grant lifecycle                                                            */
/* -------------------------------------------------------------------------- */

describe("isGrantUsable", () => {
  const issued = { status: "issued", expiresAt: NOW + GRANT_POLICY.ttlMs } as const;

  it("accepts a fresh grant", () => {
    expect(isGrantUsable(issued, NOW)).toEqual({ usable: true });
  });

  it("accepts one on the last millisecond and refuses it after", () => {
    expect(isGrantUsable(issued, issued.expiresAt)).toEqual({ usable: true });
    expect(isGrantUsable(issued, issued.expiresAt + 1)).toEqual({
      usable: false,
      reason: "expired",
    });
  });

  it("treats the clock as the rule and the status as the tidying", () => {
    // A row nobody has got round to sweeping is still expired.
    expect(isGrantUsable({ status: "issued", expiresAt: NOW - 1 }, NOW)).toEqual({
      usable: false,
      reason: "expired",
    });
    expect(isGrantUsable({ status: "expired", expiresAt: NOW + 10_000 }, NOW)).toEqual({
      usable: false,
      reason: "expired",
    });
  });

  it("refuses a consumed grant even inside its TTL", () => {
    expect(isGrantUsable({ status: "consumed", expiresAt: NOW + 10_000 }, NOW)).toEqual({
      usable: false,
      reason: "alreadyConsumed",
    });
  });

  it("expires two minutes after issue", () => {
    expect(grantExpiresAt(NOW)).toBe(NOW + 2 * 60 * 1000);
  });
});

describe("matchesGrant", () => {
  const grant = { byteSize: 1_234, checksum: CHECKSUM };

  it("accepts an exact match", () => {
    expect(matchesGrant(grant, { fileKey: "k", byteSize: 1_234, checksum: CHECKSUM })).toEqual({
      ok: true,
    });
  });

  it("refuses a body that grew between the grant and the store", () => {
    expect(matchesGrant(grant, { fileKey: "k", byteSize: 1_235 })).toEqual({
      ok: false,
      reason: "byteSize",
    });
  });

  it("refuses a swapped body when a checksum is supplied", () => {
    expect(
      matchesGrant(grant, { fileKey: "k", byteSize: 1_234, checksum: "b".repeat(64) }),
    ).toEqual({ ok: false, reason: "checksum" });
  });

  it("does not require a checksum it was never given", () => {
    expect(matchesGrant(grant, { fileKey: "k", byteSize: 1_234 })).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Throttle                                                                   */
/* -------------------------------------------------------------------------- */

describe("grant throttle", () => {
  it("namespaces its key away from the join throttle", () => {
    expect(accountGrantKey("abc")).toBe("upload:abc");
  });

  it("allows an account with no history", () => {
    expect(canIssueGrant(undefined, NOW)).toEqual({ allowed: true });
  });

  function spend(count: number, now = NOW): GrantAttemptState {
    let state = registerGrantIssued(undefined, now);
    for (let i = 1; i < count; i += 1) state = registerGrantIssued(state, now);
    return state;
  }

  it("allows right up to the ceiling and then refuses", () => {
    const justUnder = spend(GRANT_POLICY.maxPerWindow - 1);
    expect(canIssueGrant(justUnder, NOW)).toEqual({ allowed: true });

    const atCeiling = spend(GRANT_POLICY.maxPerWindow);
    const decision = canIssueGrant(atCeiling, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("hands the budget back only when the window rolls over", () => {
    const atCeiling = spend(GRANT_POLICY.maxPerWindow);
    expect(canIssueGrant(atCeiling, NOW + GRANT_POLICY.windowMs - 1).allowed).toBe(false);
    expect(canIssueGrant(atCeiling, NOW + GRANT_POLICY.windowMs).allowed).toBe(true);
  });

  it("starts a fresh window rather than accumulating across an evening", () => {
    const old = spend(GRANT_POLICY.maxPerWindow - 1);
    const next = registerGrantIssued(old, NOW + GRANT_POLICY.windowMs + 1);
    expect(next.issuedCount).toBe(1);
    expect(next.cooldownUntil).toBeUndefined();
  });

  it("does not re-arm the cooldown on every subsequent call", () => {
    const atCeiling = spend(GRANT_POLICY.maxPerWindow);
    expect(atCeiling.cooldownUntil).toBe(NOW + GRANT_POLICY.cooldownMs);
    // Still inside the cooldown: canIssueGrant refuses, so nothing re-arms it.
    expect(canIssueGrant(atCeiling, NOW + GRANT_POLICY.cooldownMs - 1).allowed).toBe(false);
  });

  it("builds a throttled result with a retry hint", () => {
    expect(grantThrottled(1_500)).toMatchObject({ outcome: "throttled", retryAfterMs: 1_500 });
  });
});

/* -------------------------------------------------------------------------- */
/* Read-path visibility (the privacy invariant, stated as data)               */
/* -------------------------------------------------------------------------- */

describe("canSeeMedia", () => {
  it("shows guests only approved media that is not theirs", () => {
    for (const state of MEDIA_STATES) {
      expect(canSeeMedia("guest", { state, isOwn: false })).toBe(state === "approved");
    }
  });

  it("shows a submitter every state of their own capture except deleted", () => {
    for (const state of MEDIA_STATES) {
      expect(canSeeMedia("guest", { state, isOwn: true })).toBe(state !== "deleted");
    }
  });

  it.each(["owner", "cohost"] as const)("shows %s everything but deleted", (role) => {
    for (const state of MEDIA_STATES) {
      expect(canSeeMedia(role, { state, isOwn: false })).toBe(state !== "deleted");
    }
  });

  it("shows a global admin nothing at all", () => {
    for (const state of MEDIA_STATES) {
      expect(canSeeMedia("globalAdmin", { state, isOwn: false })).toBe(false);
      expect(canSeeMedia("globalAdmin", { state, isOwn: true })).toBe(false);
    }
  });

  it("hides deleted media from every role, own or not", () => {
    for (const role of ROLES) {
      expect(canSeeMedia(role, { state: "deleted", isOwn: true })).toBe(false);
      expect(canSeeMedia(role, { state: "deleted", isOwn: false })).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals a retry cannot fix                                                */
/* -------------------------------------------------------------------------- */

describe("isPermanentRejection", () => {
  it("lets a paused party be retried, because hosts un-pause", () => {
    expect(isPermanentRejection("eventNotAcceptingUploads")).toBe(false);
    expect(isPermanentRejection("libraryImportDisabled")).toBe(false);
  });

  it("refuses to retry a fact about the file", () => {
    for (const reason of ["emptyFile", "tooLarge", "unsupportedMimeType", "tooLong"] as const) {
      expect(isPermanentRejection(reason)).toBe(true);
    }
  });

  it("refuses to retry a decision already taken", () => {
    expect(isPermanentRejection("duplicateCapture")).toBe(true);
    expect(isPermanentRejection("captureWithdrawn")).toBe(true);
  });

  it("classifies every reason the contract declares", () => {
    for (const reason of UPLOAD_REJECTION_REASONS) {
      expect(typeof isPermanentRejection(reason)).toBe("boolean");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Parsing what Convex answered                                               */
/* -------------------------------------------------------------------------- */

const ISSUED = {
  outcome: "granted",
  grantId: "grant_1",
  secret: "s".repeat(32),
  eventId: "event_1",
  captureId: "wdeadbeefdeadbeefdeadbeefdeadbeef",
  mediaType: "photo",
  mediaSource: "capture",
  storageRegion: "pdx1",
  byteSize: 1_000,
  maxBytes: PHOTO_MAX_BYTES,
  expiresAt: NOW + GRANT_POLICY.ttlMs,
} as const;

describe("parseGrantResult", () => {
  it("accepts all three documented outcomes", () => {
    expect(parseGrantResult(ISSUED).outcome).toBe("granted");
    expect(parseGrantResult(grantRejected("tooLarge")).outcome).toBe("rejected");
    expect(parseGrantResult(grantThrottled(1_000)).outcome).toBe("throttled");
  });

  it("accepts every rejection reason the contract declares", () => {
    for (const reason of UPLOAD_REJECTION_REASONS) {
      expect(parseGrantResult(grantRejected(reason))).toMatchObject({ reason });
    }
  });

  it("fails closed on an unknown outcome rather than assuming a grant", () => {
    expect(() => parseGrantResult({ outcome: "maybe" })).toThrow();
    expect(() => parseGrantResult(null)).toThrow();
    expect(() => parseGrantResult({})).toThrow();
  });

  it("refuses a grant whose secret is too short to be one", () => {
    expect(() => parseGrantResult({ ...ISSUED, secret: "short" })).toThrow();
  });

  it("refuses a region that is not one we store in", () => {
    expect(() => parseGrantResult({ ...ISSUED, storageRegion: "fra1" })).toThrow();
  });

  it("narrows with isIssuedGrant", () => {
    const result = parseGrantResult(ISSUED);
    expect(isIssuedGrant(result)).toBe(true);
    expect(isIssuedGrant(parseGrantResult(grantThrottled(1)))).toBe(false);
  });
});

describe("grantHasExpired", () => {
  it("is false inside the window and true once the instant arrives", () => {
    expect(grantHasExpired({ expiresAt: NOW + 1 }, NOW)).toBe(false);
    expect(grantHasExpired({ expiresAt: NOW }, NOW)).toBe(true);
    expect(grantHasExpired({ expiresAt: NOW - 1 }, NOW)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The upload ticket                                                          */
/* -------------------------------------------------------------------------- */

const TICKET_FILE = { mimeType: "image/jpeg", checksum: CHECKSUM, width: 2560, height: 1440 };

describe("buildUploadTicket", () => {
  it("takes the bound fields from the grant, not from the caller", () => {
    const ticket = buildUploadTicket(ISSUED, TICKET_FILE);
    expect(ticket).toMatchObject({
      secret: ISSUED.secret,
      eventId: ISSUED.eventId,
      captureId: ISSUED.captureId,
      mediaType: ISSUED.mediaType,
      byteSize: ISSUED.byteSize,
      mimeType: "image/jpeg",
      checksum: CHECKSUM,
    });
  });

  it("produces something the route handler's own parser accepts", () => {
    expect(uploadTicketSchema.safeParse(buildUploadTicket(ISSUED, TICKET_FILE)).success).toBe(true);
  });

  it("omits optional facts rather than sending undefined", () => {
    const ticket = buildUploadTicket(ISSUED, { mimeType: "image/jpeg", checksum: CHECKSUM });
    expect("width" in ticket).toBe(false);
    expect("durationSeconds" in ticket).toBe(false);
    expect(uploadTicketSchema.safeParse(ticket).success).toBe(true);
  });

  it("carries a video's duration through", () => {
    const grant = { ...ISSUED, mediaType: "video" } as const;
    const ticket = buildUploadTicket(grant, { ...TICKET_FILE, durationSeconds: 12 });
    expect(ticket.durationSeconds).toBe(12);
    expect(uploadTicketSchema.safeParse(ticket).success).toBe(true);
  });
});

describe("uploadTicketSchema", () => {
  it("refuses a capture id the Convex validator would refuse", () => {
    const ticket = { ...buildUploadTicket(ISSUED, TICKET_FILE), captureId: "no spaces here" };
    expect(uploadTicketSchema.safeParse(ticket).success).toBe(false);
  });

  it("refuses a checksum that is not lower-case hex SHA-256", () => {
    const ticket = { ...buildUploadTicket(ISSUED, TICKET_FILE), checksum: "A".repeat(64) };
    expect(uploadTicketSchema.safeParse(ticket).success).toBe(false);
  });
});

describe("checkTicketAgainstFiles", () => {
  const ticket = { byteSize: 1_000, mimeType: "image/jpeg" };
  const file = { name: "x.jpg", size: 1_000, type: "image/jpeg" };

  it("accepts exactly one matching file", () => {
    expect(checkTicketAgainstFiles(ticket, [file])).toEqual({ ok: true });
  });

  it("refuses zero files and more than one", () => {
    expect(checkTicketAgainstFiles(ticket, [])).toMatchObject({ reason: "fileCount" });
    expect(checkTicketAgainstFiles(ticket, [file, file])).toMatchObject({ reason: "fileCount" });
  });

  it("refuses a body that is not the size it was authorised for", () => {
    expect(checkTicketAgainstFiles(ticket, [{ ...file, size: 1_001 }])).toMatchObject({
      reason: "byteSize",
    });
  });

  it("ignores charset parameters and case, which browsers disagree about", () => {
    expect(checkTicketAgainstFiles(ticket, [{ ...file, type: "IMAGE/JPEG; charset=x" }])).toEqual({
      ok: true,
    });
  });

  it("refuses a different type", () => {
    expect(checkTicketAgainstFiles(ticket, [{ ...file, type: "image/png" }])).toMatchObject({
      reason: "mimeType",
    });
  });

  it("carries a message for every mismatch", () => {
    for (const reason of ["fileCount", "byteSize", "mimeType"] as const) {
      expect(TICKET_MISMATCH_MESSAGES[reason].length).toBeGreaterThan(0);
    }
  });
});

describe("the route the two clients agree on", () => {
  it("is one slug at one path", () => {
    expect(UPLOAD_ROUTE_SLUG).toBe("partyMedia");
    expect(UPLOAD_ROUTE_PATH).toBe("/api/uploadthing");
  });
});
