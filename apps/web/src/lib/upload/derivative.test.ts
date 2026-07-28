import { describe, expect, it, vi } from "vitest";

import {
  buildPhotoDerivatives,
  DERIVATIVE_POLICY,
  DerivativeError,
  derivativeFileName,
  fitWithin,
  planDerivatives,
  type DecodedImage,
  type Dimensions,
  type DerivativeRuntime,
} from "./derivative";

/* -------------------------------------------------------------------------- */
/* A canvas that is not a canvas                                              */
/* -------------------------------------------------------------------------- */

/**
 * The fake runtime stands in for `createImageBitmap` + `<canvas>`.
 *
 * It records every `encode` call, so the tests can assert what *would* have been
 * drawn — which is the whole of the pipeline's behaviour that matters offline.
 * `apps/web` has no DOM test environment on purpose (see `vitest.config.ts`), so
 * this seam is what makes the metadata-stripping path testable at all.
 */
function fakeRuntime(source: Dimensions, options: { encodedSize?: number } = {}) {
  const encodes: { size: Dimensions; mimeType: string; quality: number }[] = [];
  const release = vi.fn();

  const runtime: DerivativeRuntime = {
    decode: () => Promise.resolve({ ...source, source: "bitmap", release } satisfies DecodedImage),
    encode: (_image, size, mimeType, quality) => {
      encodes.push({ size, mimeType, quality });
      const bytes = options.encodedSize ?? size.width * size.height;
      return Promise.resolve(new Blob([new Uint8Array(Math.max(0, bytes))], { type: mimeType }));
    },
  };

  return { runtime, encodes, release };
}

const SOURCE = new Blob([new Uint8Array(1024)], { type: "image/heic" });

/* -------------------------------------------------------------------------- */
/* The arithmetic                                                             */
/* -------------------------------------------------------------------------- */

describe("fitWithin", () => {
  it("leaves an image already inside the box alone", () => {
    expect(fitWithin({ width: 800, height: 600 }, 2560)).toEqual({ width: 800, height: 600 });
  });

  it("never upscales", () => {
    expect(fitWithin({ width: 300, height: 200 }, 2560)).toEqual({ width: 300, height: 200 });
  });

  it("scales the long edge down and keeps the aspect ratio", () => {
    expect(fitWithin({ width: 4032, height: 3024 }, 2560)).toEqual({ width: 2560, height: 1920 });
  });

  it("works on portrait as well as landscape", () => {
    expect(fitWithin({ width: 3024, height: 4032 }, 2560)).toEqual({ width: 1920, height: 2560 });
  });

  it("never returns a zero dimension, which would throw on a canvas", () => {
    expect(fitWithin({ width: 10_000, height: 1 }, 100)).toEqual({ width: 100, height: 1 });
  });

  it("survives nonsense dimensions", () => {
    expect(fitWithin({ width: 0, height: 0 }, 2560)).toEqual({ width: 1, height: 1 });
    expect(fitWithin({ width: Number.NaN, height: 10 }, 2560)).toEqual({ width: 1, height: 1 });
  });
});

describe("planDerivatives", () => {
  it("plans both sizes from one source", () => {
    const plan = planDerivatives({ width: 4032, height: 3024 });
    expect(plan.upload).toEqual({ width: 2560, height: 1920 });
    expect(plan.preview).toEqual({ width: 480, height: 360 });
  });
});

/* -------------------------------------------------------------------------- */
/* The pipeline                                                               */
/* -------------------------------------------------------------------------- */

describe("buildPhotoDerivatives", () => {
  it("re-encodes both derivatives to the output type, never the source type", async () => {
    // The HEIC in, JPEG out case: this is the actual iPhone default, and it is
    // also the round trip that drops the EXIF/GPS block.
    const { runtime, encodes } = fakeRuntime({ width: 4032, height: 3024 });

    const result = await buildPhotoDerivatives(SOURCE, runtime);

    expect(encodes).toHaveLength(2);
    for (const call of encodes) expect(call.mimeType).toBe(DERIVATIVE_POLICY.outputMimeType);
    expect(result.upload.type).toBe("image/jpeg");
    expect(result.preview.type).toBe("image/jpeg");
  });

  it("encodes the upload derivative before the preview, at the policy's sizes and qualities", async () => {
    const { runtime, encodes } = fakeRuntime({ width: 4032, height: 3024 });

    await buildPhotoDerivatives(SOURCE, runtime);

    expect(encodes[0]).toMatchObject({
      size: { width: 2560, height: 1920 },
      quality: DERIVATIVE_POLICY.uploadQuality,
    });
    expect(encodes[1]).toMatchObject({
      size: { width: 480, height: 360 },
      quality: DERIVATIVE_POLICY.previewQuality,
    });
  });

  it("reports the dimensions of what it produced, not of the source", async () => {
    const { runtime } = fakeRuntime({ width: 4032, height: 3024 });

    const result = await buildPhotoDerivatives(SOURCE, runtime);

    expect(result.dimensions).toEqual({ width: 2560, height: 1920 });
    expect(result.sourceDimensions).toEqual({ width: 4032, height: 3024 });
  });

  it("claims stripped metadata only on a real round trip", async () => {
    // ADR 0004 §7: `sourceMetadataStripped` is recorded, not assumed. It comes
    // from here, and here only reaches this line after two encodes.
    const { runtime } = fakeRuntime({ width: 1200, height: 900 });
    const result = await buildPhotoDerivatives(SOURCE, runtime);
    expect(result.metadataStripped).toBe(true);
  });

  it("releases the decoded bitmap even when encoding fails", async () => {
    const { runtime, release } = fakeRuntime({ width: 1200, height: 900 });
    const failing: DerivativeRuntime = {
      decode: runtime.decode.bind(runtime),
      encode: () => Promise.reject(new Error("canvas exploded")),
    };

    await expect(buildPhotoDerivatives(SOURCE, failing)).rejects.toBeInstanceOf(DerivativeError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws rather than falling back to the untouched original", async () => {
    // The failure mode this guards is the important one: an un-re-encoded file
    // still carries GPS, and uploading it would put coordinates into storage.
    const failing: DerivativeRuntime = {
      decode: () => Promise.reject(new Error("cannot decode")),
      encode: () => Promise.reject(new Error("unreachable")),
    };

    await expect(buildPhotoDerivatives(SOURCE, failing)).rejects.toBeInstanceOf(DerivativeError);
  });

  it("refuses an encoder that produced nothing", async () => {
    const { runtime } = fakeRuntime({ width: 1200, height: 900 }, { encodedSize: 0 });
    await expect(buildPhotoDerivatives(SOURCE, runtime)).rejects.toBeInstanceOf(DerivativeError);
  });

  it("keeps the original error as the cause, for Sentry", async () => {
    const original = new Error("cannot decode");
    const failing: DerivativeRuntime = {
      decode: () => Promise.reject(original),
      encode: () => Promise.reject(new Error("unreachable")),
    };

    await expect(buildPhotoDerivatives(SOURCE, failing)).rejects.toMatchObject({
      cause: original,
    });
  });
});

describe("derivativeFileName", () => {
  it("names the file after the capture, with the output extension", () => {
    expect(derivativeFileName("w0123456789abcdef")).toBe("w0123456789abcdef.jpg");
  });
});
