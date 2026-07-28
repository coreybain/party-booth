import { describe, expect, it } from "vitest";

import { MEDIA_LIMITS, VIDEO_MAX_DURATION_SECONDS } from "@/lib/contracts";
import {
  DerivativeError,
  type DecodedImage,
  type DerivativeRuntime,
  type Dimensions,
} from "@/lib/upload/derivative";
import {
  buildVideoFacts,
  checkVideoFile,
  formatDuration,
  isProbablySupportedVideo,
  planPosterSize,
  POSTER_POLICY,
  posterFileName,
  posterFrameTime,
  type OpenedVideo,
  type VideoRuntime,
} from "@/lib/upload/video";

const MIB = 1024 * 1024;

/**
 * `Blob` in Node reports its real length, and the tests care about the declared
 * size rather than about allocating megabytes. This wraps one with a fixed size.
 */
function sizedClip(size: number, type = "video/mp4"): Blob {
  return Object.defineProperty(new Blob([new Uint8Array(1)], { type }), "size", {
    value: size,
  }) as Blob;
}

function fakeVideoRuntime(
  facts: { durationSeconds: number; width: number; height: number },
  options: { failOpen?: boolean } = {},
) {
  const seeks: number[] = [];
  let released = 0;

  const runtime: VideoRuntime = {
    open: (): Promise<OpenedVideo> => {
      if (options.failOpen === true) return Promise.reject(new Error("no decoder"));
      return Promise.resolve({
        durationSeconds: facts.durationSeconds,
        width: facts.width,
        height: facts.height,
        frameAt: (seconds: number): Promise<DecodedImage> => {
          seeks.push(seconds);
          return Promise.resolve({
            width: facts.width,
            height: facts.height,
            source: "frame",
            release: () => undefined,
          });
        },
        release: () => {
          released += 1;
        },
      });
    },
  };

  return { runtime, seeks, releases: () => released };
}

function fakeEncoder(options: { emptyOutput?: boolean } = {}) {
  const encodes: { size: Dimensions; mimeType: string; quality: number }[] = [];
  const runtime: DerivativeRuntime = {
    decode: () => Promise.reject(new Error("not used")),
    encode: (_image, size, mimeType, quality) => {
      encodes.push({ size, mimeType, quality });
      const bytes = options.emptyOutput === true ? 0 : 1_024;
      return Promise.resolve(
        Object.defineProperty(new Blob([new Uint8Array(1)], { type: mimeType }), "size", {
          value: bytes,
        }) as Blob,
      );
    },
  };
  return { runtime, encodes };
}

describe("poster arithmetic", () => {
  it("takes the frame a second in, or the midpoint of anything shorter", () => {
    // Frame zero is very often the lens still adjusting, and that frame then
    // represents the video everywhere it appears.
    expect(posterFrameTime(60)).toBe(1);
    expect(posterFrameTime(1.2)).toBe(0.6);
    expect(posterFrameTime(0)).toBe(0);
    expect(posterFrameTime(Number.NaN)).toBe(0);
  });

  it("fits the poster inside the policy's longest edge", () => {
    expect(planPosterSize({ width: 3840, height: 2160 })).toEqual({ width: 1280, height: 720 });
    // Never upscales a small source.
    expect(planPosterSize({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });

  it("names the poster distinctly from the clip", () => {
    expect(posterFileName("cap_123")).toBe("cap_123-poster.jpg");
  });

  it("formats a duration the way a chip reads it", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9.4)).toBe("0:09");
    expect(formatDuration(64)).toBe("1:04");
  });
});

describe("pre-checks", () => {
  it("accepts a clip inside every limit", () => {
    expect(
      checkVideoFile({ byteSize: 10 * MIB, mimeType: "video/mp4", durationSeconds: 20 }),
    ).toEqual({
      ok: true,
    });
  });

  it("refuses one that is too long, in the contract's own words", () => {
    const result = checkVideoFile({
      byteSize: MIB,
      mimeType: "video/mp4",
      durationSeconds: VIDEO_MAX_DURATION_SECONDS + 1,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain(String(VIDEO_MAX_DURATION_SECONDS));
  });

  it("refuses one that is too big before its length is even known", () => {
    const result = checkVideoFile({
      byteSize: MEDIA_LIMITS.video.maxBytes + 1,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("insists on a duration for the original", () => {
    // A grant without one is a grant Convex refuses, so asking here saves the
    // round trip rather than inventing a rule.
    expect(checkVideoFile({ byteSize: MIB, mimeType: "video/mp4" })).toMatchObject({ ok: false });
  });

  it("knows which container types are worth offering", () => {
    expect(isProbablySupportedVideo("video/mp4")).toBe(true);
    expect(isProbablySupportedVideo("video/quicktime")).toBe(true);
    expect(isProbablySupportedVideo("video/x-matroska")).toBe(false);
  });
});

describe("buildVideoFacts", () => {
  it("reads the clip, seeks and encodes exactly one poster", async () => {
    const video = fakeVideoRuntime({ durationSeconds: 30, width: 1920, height: 1080 });
    const encoder = fakeEncoder();

    const facts = await buildVideoFacts(sizedClip(8 * MIB), video.runtime, encoder.runtime);

    expect(video.seeks).toEqual([1]);
    expect(encoder.encodes).toHaveLength(1);
    expect(encoder.encodes[0]).toMatchObject({
      size: { width: 1280, height: 720 },
      mimeType: POSTER_POLICY.mimeType,
      quality: POSTER_POLICY.quality,
    });
    expect(facts.durationSeconds).toBe(30);
    expect(facts.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(facts.posterDimensions).toEqual({ width: 1280, height: 720 });
  });

  it("refuses a clip over the duration limit without encoding anything", async () => {
    const video = fakeVideoRuntime({ durationSeconds: 90, width: 1920, height: 1080 });
    const encoder = fakeEncoder();

    await expect(
      buildVideoFacts(sizedClip(8 * MIB), video.runtime, encoder.runtime),
    ).rejects.toBeInstanceOf(DerivativeError);
    expect(encoder.encodes).toEqual([]);
  });

  it("refuses a clip whose length the decoder would not say", async () => {
    const video = fakeVideoRuntime({ durationSeconds: Number.NaN, width: 100, height: 100 });
    await expect(
      buildVideoFacts(sizedClip(MIB), video.runtime, fakeEncoder().runtime),
    ).rejects.toBeInstanceOf(DerivativeError);
  });

  it("turns a decoder that will not open into one sentence", async () => {
    const video = fakeVideoRuntime(
      { durationSeconds: 10, width: 10, height: 10 },
      { failOpen: true },
    );
    await expect(
      buildVideoFacts(sizedClip(MIB), video.runtime, fakeEncoder().runtime),
    ).rejects.toBeInstanceOf(DerivativeError);
  });

  it("refuses an encoder that produced nothing", async () => {
    const video = fakeVideoRuntime({ durationSeconds: 10, width: 640, height: 480 });
    await expect(
      buildVideoFacts(sizedClip(MIB), video.runtime, fakeEncoder({ emptyOutput: true }).runtime),
    ).rejects.toBeInstanceOf(DerivativeError);
  });

  it("always releases the decoder, including on failure", async () => {
    const ok = fakeVideoRuntime({ durationSeconds: 10, width: 640, height: 480 });
    await buildVideoFacts(sizedClip(MIB), ok.runtime, fakeEncoder().runtime);
    expect(ok.releases()).toBe(1);

    const bad = fakeVideoRuntime({ durationSeconds: 999, width: 640, height: 480 });
    await expect(
      buildVideoFacts(sizedClip(MIB), bad.runtime, fakeEncoder().runtime),
    ).rejects.toBeInstanceOf(DerivativeError);
    expect(bad.releases()).toBe(1);
  });
});
