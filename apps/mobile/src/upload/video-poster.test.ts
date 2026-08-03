import { describe, expect, it, vi } from "vitest";

import { generateVideoPosterFrame } from "./video-poster";

import type { VideoPlayer, VideoThumbnail } from "expo-video";

function thumbnail(name: string): VideoThumbnail {
  return { name } as unknown as VideoThumbnail;
}

function player(overrides: Partial<Pick<VideoPlayer, "generateThumbnailsAsync" | "replaceAsync">>) {
  return {
    replaceAsync: vi.fn().mockResolvedValue(undefined),
    generateThumbnailsAsync: vi.fn().mockResolvedValue([thumbnail("preferred")]),
    ...overrides,
  } as Pick<VideoPlayer, "generateThumbnailsAsync" | "replaceAsync">;
}

describe("generateVideoPosterFrame", () => {
  it("loads the recorded file before asking for its preferred frame", async () => {
    const calls: string[] = [];
    const source = player({
      replaceAsync: vi.fn(async () => {
        calls.push("loaded");
      }),
      generateThumbnailsAsync: vi.fn(async () => {
        calls.push("thumbnail");
        return [thumbnail("preferred")];
      }),
    });

    await generateVideoPosterFrame(source, "file:///capture.mov", 12, 1280);

    expect(calls).toEqual(["loaded", "thumbnail"]);
    expect(source.replaceAsync).toHaveBeenCalledWith({ uri: "file:///capture.mov" });
    expect(source.generateThumbnailsAsync).toHaveBeenCalledWith([1], { maxWidth: 1280 });
  });

  it("falls back to frame zero when the preferred frame cannot be extracted", async () => {
    const fallback = thumbnail("fallback");
    const source = player({
      generateThumbnailsAsync: vi
        .fn()
        .mockRejectedValueOnce(new Error("frame unavailable"))
        .mockResolvedValueOnce([fallback]),
    });

    await expect(generateVideoPosterFrame(source, "file:///capture.mov", 12, 1280)).resolves.toBe(
      fallback,
    );
    expect(source.generateThumbnailsAsync).toHaveBeenNthCalledWith(1, [1], { maxWidth: 1280 });
    expect(source.generateThumbnailsAsync).toHaveBeenNthCalledWith(2, [0], { maxWidth: 1280 });
  });

  it("fails the capture when neither frame produces an image", async () => {
    const source = player({ generateThumbnailsAsync: vi.fn().mockResolvedValue([]) });

    await expect(generateVideoPosterFrame(source, "file:///capture.mov", 12, 1280)).rejects.toThrow(
      "did not yield a preview frame",
    );
  });
});
