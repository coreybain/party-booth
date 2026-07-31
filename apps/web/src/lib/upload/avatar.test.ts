import { describe, expect, it } from "vitest";

import { authoriseAvatarUploadAtEdge } from "./avatar";

const checksum = "a".repeat(64);
const ticket = {
  secret: "avatar-secret-long-enough",
  byteSize: 1_024,
  mimeType: "image/jpeg" as const,
  checksum,
};

describe("authoriseAvatarUploadAtEdge", () => {
  it("accepts one offered JPEG matching the authoritative grant", () => {
    expect(
      authoriseAvatarUploadAtEdge(
        ticket,
        [{ name: "avatar.jpg", size: 1_024, type: "image/jpeg" }],
        ticket,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a swapped offered body before upload", () => {
    expect(
      authoriseAvatarUploadAtEdge(
        ticket,
        [{ name: "avatar.jpg", size: 2_048, type: "image/jpeg" }],
        ticket,
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects a ticket that disagrees with Convex's grant", () => {
    expect(
      authoriseAvatarUploadAtEdge(
        ticket,
        [{ name: "avatar.jpg", size: 1_024, type: "image/jpeg" }],
        {
          ...ticket,
          checksum: "b".repeat(64),
        },
      ),
    ).toMatchObject({ ok: false });
  });
});
