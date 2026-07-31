import { describe, expect, it, vi } from "vitest";

import {
  requireSuccessfulAvatarCompletion,
  uploadAvatar,
  type AvatarUploadRuntime,
  type PreparedAvatar,
} from "./avatar-upload";

const file: PreparedAvatar = {
  uri: "file:///tmp/avatar.jpg",
  name: "avatar.jpg",
  byteSize: 1_024,
  mimeType: "image/jpeg",
  checksum: "a".repeat(64),
};

function runtime(over: Partial<AvatarUploadRuntime> = {}): AvatarUploadRuntime {
  return {
    prepare: vi.fn().mockResolvedValue(file),
    upload: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("uploadAvatar", () => {
  it("requests a grant for the exact prepared JPEG and uploads its ticket", async () => {
    const native = runtime();
    const requestGrant = vi.fn().mockResolvedValue({
      secret: "server-grant-secret-long-enough",
      expiresAt: Date.now() + 60_000,
      byteSize: file.byteSize,
      mimeType: file.mimeType,
      checksum: file.checksum,
    });

    await uploadAvatar({
      sourceUri: "file:///picker/source.png",
      siteUrl: "https://partybooth.test/",
      authHeaders: { Cookie: "better-auth.session_token=private" },
      requestGrant,
      runtime: native,
    });

    expect(requestGrant).toHaveBeenCalledWith({
      byteSize: file.byteSize,
      mimeType: file.mimeType,
      checksum: file.checksum,
    });
    expect(native.upload).toHaveBeenCalledWith({
      siteUrl: "https://partybooth.test/",
      file,
      ticket: {
        secret: "server-grant-secret-long-enough",
        byteSize: file.byteSize,
        mimeType: file.mimeType,
        checksum: file.checksum,
      },
      authHeaders: { Cookie: "better-auth.session_token=private" },
    });
    expect(native.dispose).toHaveBeenCalledWith(file.uri);
  });

  it("always removes the re-encoded temp file when the upload fails", async () => {
    const native = runtime({ upload: vi.fn().mockRejectedValue(new Error("offline")) });

    await expect(
      uploadAvatar({
        sourceUri: "file:///picker/source.png",
        siteUrl: "https://partybooth.test",
        requestGrant: vi.fn().mockResolvedValue({
          secret: "server-grant-secret-long-enough",
          expiresAt: Date.now() + 60_000,
          byteSize: file.byteSize,
          mimeType: file.mimeType,
          checksum: file.checksum,
        }),
        runtime: native,
      }),
    ).rejects.toThrow("offline");
    expect(native.dispose).toHaveBeenCalledWith(file.uri);
  });

  it("refuses an oversized prepared file before asking Convex for a grant", async () => {
    const native = runtime({
      prepare: vi.fn().mockResolvedValue({ ...file, byteSize: 3 * 1024 * 1024 }),
    });
    const requestGrant = vi.fn();

    await expect(
      uploadAvatar({
        sourceUri: "file:///picker/source.png",
        siteUrl: "https://partybooth.test",
        requestGrant,
        runtime: native,
      }),
    ).rejects.toThrow();
    expect(requestGrant).not.toHaveBeenCalled();
    expect(native.dispose).toHaveBeenCalledWith(file.uri);
  });
});

describe("avatar callback completion", () => {
  it("accepts registered and idempotent duplicate callbacks", () => {
    expect(() => requireSuccessfulAvatarCompletion({ outcome: "registered" })).not.toThrow();
    expect(() => requireSuccessfulAvatarCompletion({ outcome: "duplicate" })).not.toThrow();
  });

  it("rejects a normally-returned callback that did not attach the avatar", () => {
    expect(() =>
      requireSuccessfulAvatarCompletion({ outcome: "discarded", reason: "fileMismatch" }),
    ).toThrow(/profile photo/i);
  });
});
