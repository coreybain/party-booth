import { describe, expect, it } from "vitest";

import {
  adminAccountActionInputSchema,
  createEventInputSchema,
  emailSchema,
  eventScheduleSchema,
  hexColorSchema,
  joinEventInputSchema,
  timeZoneSchema,
  uploadGrantRequestSchema,
} from "./schemas";

const CHECKSUM = "a".repeat(64);

describe("primitives", () => {
  it("lower-cases and trims email addresses", () => {
    expect(emailSchema.parse("  Corey@Example.COM ")).toBe("corey@example.com");
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("normalises hex colours", () => {
    expect(hexColorSchema.parse("#FF00AA")).toBe("#ff00aa");
    expect(hexColorSchema.safeParse("#f0a").success).toBe(false);
    expect(hexColorSchema.safeParse("red").success).toBe(false);
  });

  it("accepts IANA time-zone names", () => {
    expect(timeZoneSchema.safeParse("Europe/London").success).toBe(true);
    expect(timeZoneSchema.safeParse("America/Argentina/Buenos_Aires").success).toBe(true);
    expect(timeZoneSchema.safeParse("UTC").success).toBe(true);
    expect(timeZoneSchema.safeParse("Europe / London").success).toBe(false);
  });
});

describe("eventScheduleSchema", () => {
  it("requires the end to come after the start", () => {
    expect(
      eventScheduleSchema.safeParse({ startsAt: 2000, endsAt: 1000, timeZone: "Europe/London" })
        .success,
    ).toBe(false);
    expect(
      eventScheduleSchema.safeParse({ startsAt: 1000, endsAt: 2000, timeZone: "Europe/London" })
        .success,
    ).toBe(true);
  });

  it("allows an open-ended party", () => {
    expect(
      eventScheduleSchema.safeParse({ startsAt: 1000, timeZone: "Europe/London" }).success,
    ).toBe(true);
  });
});

describe("createEventInputSchema", () => {
  const base = {
    name: "Corey's birthday",
    schedule: { startsAt: 1_800_000_000_000, timeZone: "Europe/London" },
  };

  it("defaults to manual moderation and library import", () => {
    const parsed = createEventInputSchema.parse(base);
    expect(parsed.moderationMode).toBe("manual");
    expect(parsed.allowLibraryImport).toBe(true);
  });

  it("refuses the ai moderation mode until P1 ships it", () => {
    expect(createEventInputSchema.safeParse({ ...base, moderationMode: "ai" }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...base, moderationMode: "automatic" }).success).toBe(
      true,
    );
  });

  it("refuses a storage region we cannot write to", () => {
    expect(createEventInputSchema.safeParse({ ...base, storageRegion: "pdx1" }).success).toBe(true);
    expect(createEventInputSchema.safeParse({ ...base, storageRegion: "iad1" }).success).toBe(
      false,
    );
  });

  it("refuses a blank name", () => {
    expect(createEventInputSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });
});

describe("joinEventInputSchema", () => {
  it("normalises a typed code", () => {
    const parsed = joinEventInputSchema.parse({ via: "code", code: "48 29-13" });
    expect(parsed).toEqual({ via: "code", code: "482913" });
  });

  it("normalises a scanned token", () => {
    const token = "0".repeat(32);
    expect(joinEventInputSchema.parse({ via: "token", token })).toEqual({ via: "token", token });
  });

  it("rejects a token that is the wrong shape", () => {
    expect(joinEventInputSchema.safeParse({ via: "token", token: "nope" }).success).toBe(false);
  });
});

describe("uploadGrantRequestSchema", () => {
  const base = {
    eventId: "evt_1",
    captureId: "capture-0001",
    mediaType: "photo" as const,
    byteSize: 1024,
    mimeType: "image/jpeg",
    checksum: CHECKSUM,
  };

  it("accepts a photo request", () => {
    expect(uploadGrantRequestSchema.parse(base).fromLibrary).toBe(false);
  });

  it("insists on a duration for videos", () => {
    expect(
      uploadGrantRequestSchema.safeParse({ ...base, mediaType: "video", mimeType: "video/mp4" })
        .success,
    ).toBe(false);
    expect(
      uploadGrantRequestSchema.safeParse({
        ...base,
        mediaType: "video",
        mimeType: "video/mp4",
        durationSeconds: 30,
      }).success,
    ).toBe(true);
  });

  it("caps the video duration at sixty seconds", () => {
    expect(
      uploadGrantRequestSchema.safeParse({
        ...base,
        mediaType: "video",
        mimeType: "video/mp4",
        durationSeconds: 61,
      }).success,
    ).toBe(false);
  });

  it("requires a lower-case hex SHA-256", () => {
    expect(uploadGrantRequestSchema.safeParse({ ...base, checksum: "A".repeat(64) }).success).toBe(
      false,
    );
    expect(uploadGrantRequestSchema.safeParse({ ...base, checksum: "abc" }).success).toBe(false);
  });

  it("requires a non-trivial captureId so retries stay idempotent", () => {
    expect(uploadGrantRequestSchema.safeParse({ ...base, captureId: "1" }).success).toBe(false);
  });
});

describe("adminAccountActionInputSchema", () => {
  it("will not let a destructive admin action through without a reason", () => {
    expect(adminAccountActionInputSchema.safeParse({ userId: "u1" }).success).toBe(false);
    expect(adminAccountActionInputSchema.safeParse({ userId: "u1", reason: "  " }).success).toBe(
      false,
    );
    expect(
      adminAccountActionInputSchema.safeParse({ userId: "u1", reason: "Spam uploads" }).success,
    ).toBe(true);
  });
});
