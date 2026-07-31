import { describe, expect, it } from "vitest";

import {
  AVATAR_MAX_BYTES,
  avatarPixelSize,
  avatarUploadRequestSchema,
  avatarUploadTicketSchema,
  buildAvatarUploadTicket,
  checkAvatarTicketAgainstFiles,
  checkAvatarTicketAgainstGrant,
  parseAvatarUploadCompletionResult,
  type IssuedAvatarUploadGrant,
} from "./avatar";

const grant: IssuedAvatarUploadGrant = {
  secret: "s".repeat(32),
  expiresAt: 1_800_000_120_000,
  byteSize: 42_000,
  mimeType: "image/jpeg",
  checksum: "a".repeat(64),
};

describe("avatar upload contract", () => {
  it("accepts only a bounded re-encoded JPEG", () => {
    expect(avatarUploadRequestSchema.safeParse(grant).success).toBe(true);
    expect(
      avatarUploadRequestSchema.safeParse({
        byteSize: AVATAR_MAX_BYTES + 1,
        mimeType: "image/jpeg",
        checksum: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      avatarUploadRequestSchema.safeParse({
        byteSize: 42_000,
        mimeType: "image/png",
        checksum: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("builds the route ticket only from server-returned grant facts", () => {
    const ticket = buildAvatarUploadTicket(grant);
    expect(avatarUploadTicketSchema.parse(ticket)).toEqual({
      secret: grant.secret,
      byteSize: grant.byteSize,
      mimeType: grant.mimeType,
      checksum: grant.checksum,
    });
    expect(ticket).not.toHaveProperty("fileKey");
  });

  it("checks both the offered file and the authoritative grant", () => {
    const ticket = buildAvatarUploadTicket(grant);
    expect(
      checkAvatarTicketAgainstFiles(ticket, [
        { name: "avatar.jpg", size: grant.byteSize, type: grant.mimeType },
      ]),
    ).toEqual({ ok: true });
    expect(checkAvatarTicketAgainstGrant(ticket, grant)).toEqual({ ok: true });
    expect(checkAvatarTicketAgainstGrant({ ...ticket, checksum: "b".repeat(64) }, grant)).toEqual(
      expect.objectContaining({ ok: false, reason: "checksum" }),
    );
  });

  it("fits within 512 px without stretching", () => {
    expect(avatarPixelSize({ width: 2_000, height: 1_000 })).toEqual({ width: 512, height: 256 });
    expect(avatarPixelSize({ width: 200, height: 100 })).toEqual({ width: 200, height: 100 });
  });

  it("parses safe callback data and rejects unknown outcomes", () => {
    expect(parseAvatarUploadCompletionResult({ outcome: "registered" })).toEqual({
      outcome: "registered",
    });
    expect(
      parseAvatarUploadCompletionResult({ outcome: "discarded", reason: "accountUnavailable" }),
    ).toEqual({ outcome: "discarded", reason: "accountUnavailable" });
    expect(() => parseAvatarUploadCompletionResult({ outcome: "surprise" })).toThrow();
  });
});
