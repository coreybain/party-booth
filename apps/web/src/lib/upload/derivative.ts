/**
 * Client-side derivative generation — the place PartyBooth's location-metadata
 * promise is actually kept.
 *
 * PLAN.md: *"strip location metadata from derivatives"*. ADR 0004 §7 chooses to
 * do it **at capture, by re-encoding**, rather than server-side, and this is the
 * web half of that decision (Expo's `ImageManipulator` is the other half).
 *
 * ## Why a canvas round trip strips EXIF
 *
 * A JPEG from a phone camera is image data wrapped in APP1/EXIF and (on iOS)
 * often APP1/XMP segments: GPS coordinates to five decimal places, the device's
 * make, model and serial, the exposure settings, and the capture timestamp.
 * Decoding to a bitmap keeps **only the pixels** — every metadata segment is
 * dropped at that point, because a bitmap has nowhere to put it. Re-encoding
 * from a canvas then writes a fresh JPEG whose only APP segments are the ones
 * the encoder emits (JFIF density), so there is no GPS block to strip: there was
 * never one written.
 *
 * Two consequences worth stating, because they are easy to get wrong:
 *
 * - **Orientation must survive.** EXIF `Orientation` is metadata too, so a naive
 *   re-encode of an iPhone portrait photo produces a sideways JPEG. The decode
 *   step therefore has to bake rotation into the pixels — `createImageBitmap`
 *   with `imageOrientation: "from-image"`, or an `<img>` element, which every
 *   modern engine orients for us. See `browserDerivativeRuntime`.
 * - **The claim is recorded, not assumed.** The upload grant carries
 *   `sourceMetadataStripped`, and it is only ever set from
 *   {@link Derivatives.metadataStripped} — the value this module actually
 *   produced, never a hardcoded `true`. A browser too old to give us a canvas
 *   is a browser whose upload is marked unstripped, not one that quietly lies.
 *
 * ## Shape of this module
 *
 * The arithmetic (`fitWithin`, `planDerivatives`) is pure and directly tested.
 * Everything that touches a `document` sits behind {@link DerivativeRuntime},
 * which the tests replace with a fake — `apps/web` has no DOM test environment
 * on purpose (PLAN.md puts browser-level testing in Sprint 6, behind
 * Playwright), and a pipeline that can only be verified in a browser is a
 * pipeline that is verified the night of the party.
 */

/* -------------------------------------------------------------------------- */
/* Policy and arithmetic — shared with apps/mobile                            */
/* -------------------------------------------------------------------------- */

import {
  DERIVATIVE_PROFILES,
  fitWithin,
  type DerivativeProfile,
  type PixelSize,
} from "@/lib/contracts";

export { fitWithin };
export type Dimensions = PixelSize;
export type DerivativePolicy = DerivativeProfile;

/**
 * This app's row of `DERIVATIVE_PROFILES`.
 *
 * The numbers, and the reasoning behind them, live in
 * `@partybooth/contracts/capture` next to the native profile — so the two
 * clients' choices sit side by side and the difference between them is a
 * documented decision rather than an accident of who wrote which file. The
 * short version: the ceiling here is set by mobile Safari's canvas area limit,
 * which `expo-image-manipulator` does not have. `fitWithin` is shared for the
 * same reason: two copies of one piece of arithmetic is one copy too many.
 *
 * `previewMaxEdge` is a local thumbnail only. It never leaves the device — the
 * completion API takes one file per capture, so there is nowhere to put a second
 * object. It exists so "My media" shows the guest their own photo the instant
 * they press send rather than a grey box until a signed URL arrives.
 */
export const DERIVATIVE_POLICY: DerivativeProfile = DERIVATIVE_PROFILES.web;

export interface DerivativePlan {
  readonly upload: Dimensions;
  readonly preview: Dimensions;
}

export function planDerivatives(
  source: Dimensions,
  policy: DerivativePolicy = DERIVATIVE_POLICY,
): DerivativePlan {
  return {
    upload: fitWithin(source, policy.uploadMaxEdge),
    preview: fitWithin(source, policy.previewMaxEdge),
  };
}

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A decoded frame. `source` is whatever the runtime wants to draw later —
 * an `ImageBitmap` or an `HTMLImageElement` in a browser, anything at all in a
 * test — so this module never names a DOM type.
 */
export interface DecodedImage extends Dimensions {
  readonly source: unknown;
  /** Frees the underlying bitmap. Always called, including on failure. */
  release(): void;
}

export interface DerivativeRuntime {
  decode(blob: Blob): Promise<DecodedImage>;
  encode(image: DecodedImage, size: Dimensions, mimeType: string, quality: number): Promise<Blob>;
}

export class DerivativeError extends Error {
  override readonly name = "DerivativeError";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

export interface Derivatives {
  /** The frame that is actually uploaded. Re-encoded, so metadata-free. */
  readonly upload: Blob;
  /** A local thumbnail. Never uploaded — see {@link DERIVATIVE_POLICY}. */
  readonly preview: Blob;
  /** Pixel dimensions of {@link upload}, for the media row. */
  readonly dimensions: Dimensions;
  readonly sourceDimensions: Dimensions;
  /**
   * Whether the frame really did go through a decode/re-encode round trip.
   *
   * Always `true` here — the function throws rather than returning an
   * un-stripped frame — and it exists as a field so no call site is ever
   * tempted to write `sourceMetadataStripped: true` next to a file it did not
   * re-encode. ADR 0004: the claim is recorded, not assumed.
   */
  readonly metadataStripped: true;
}

/**
 * Decode a captured photo and re-encode it twice: once for upload, once for a
 * local thumbnail.
 *
 * Throws {@link DerivativeError} on any failure, and that is the correct
 * behaviour rather than a fallback to the original bytes: uploading the file
 * exactly as the camera produced it would put GPS coordinates into private
 * storage, which is the one outcome ADR 0004 exists to prevent. A guest whose
 * browser cannot do this is told their browser cannot do this.
 */
export async function buildPhotoDerivatives(
  file: Blob,
  runtime: DerivativeRuntime,
  policy: DerivativePolicy = DERIVATIVE_POLICY,
): Promise<Derivatives> {
  let decoded: DecodedImage;
  try {
    decoded = await runtime.decode(file);
  } catch (error) {
    throw new DerivativeError("That photo could not be opened on this device.", error);
  }

  try {
    const sourceDimensions: Dimensions = { width: decoded.width, height: decoded.height };
    const plan = planDerivatives(sourceDimensions, policy);

    const upload = await runtime.encode(
      decoded,
      plan.upload,
      policy.outputMimeType,
      policy.uploadQuality,
    );
    const preview = await runtime.encode(
      decoded,
      plan.preview,
      policy.outputMimeType,
      policy.previewQuality,
    );

    if (upload.size <= 0) {
      throw new DerivativeError("That photo came back empty after processing.");
    }

    return {
      upload,
      preview,
      dimensions: plan.upload,
      sourceDimensions,
      metadataStripped: true,
    };
  } catch (error) {
    if (error instanceof DerivativeError) throw error;
    throw new DerivativeError("That photo could not be prepared for upload.", error);
  } finally {
    // Bitmaps are off-heap on every engine that has them; a guest taking thirty
    // photos in a row on an old phone is exactly who runs out of memory.
    decoded.release();
  }
}

/** `image/jpeg` → a filename the storage provider and the host can both read. */
export function derivativeFileName(
  captureId: string,
  policy: DerivativePolicy = DERIVATIVE_POLICY,
): string {
  return `${captureId}.${policy.outputExtension}`;
}

/* -------------------------------------------------------------------------- */
/* The browser implementation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The real runtime. Nothing at module scope touches `document`, so importing
 * this file on the server (or in a Node test) is safe; only calling it is not.
 *
 * Two decode paths, tried in order, because the guest phones this has to work on
 * do not agree:
 *
 * 1. `createImageBitmap(blob, { imageOrientation: "from-image" })` — cheapest,
 *    decodes off the main thread, and explicitly bakes EXIF rotation into the
 *    pixels. Supported by Chrome on Android and Safari 17+.
 * 2. An `<img>` fed an object URL, awaited with `decode()`. Slower and
 *    main-thread, but universally available, and every engine applies EXIF
 *    orientation when rendering an `<img>` — which is the property we need.
 *
 * Path 2 is not dead code: Safari shipped `createImageBitmap` before it shipped
 * the options bag, and older iOS versions reject the second argument outright.
 * That is precisely the phone in somebody's pocket on 5 August.
 */
export const browserDerivativeRuntime: DerivativeRuntime = {
  async decode(blob: Blob): Promise<DecodedImage> {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        return {
          width: bitmap.width,
          height: bitmap.height,
          source: bitmap,
          release: () => {
            bitmap.close();
          },
        };
      } catch {
        // Fall through to the <img> path rather than failing: an engine that
        // rejects the options bag must not be handed an unrotated bitmap.
      }
    }
    return await decodeViaImageElement(blob);
  },

  async encode(image, size, mimeType, quality): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new DerivativeError("This browser cannot process photos.");

    // JPEG has no alpha, so anything transparent in the source would otherwise
    // encode as black. Paint the sheet white first.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(image.source as CanvasImageSource, 0, 0, size.width, size.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob === null) {
            reject(new DerivativeError("This browser could not encode the photo."));
            return;
          }
          resolve(blob);
        },
        mimeType,
        quality,
      );
    });
  },
};

async function decodeViaImageElement(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob);
  const element = new Image();
  // Same-origin blob URL, but stating it keeps the element out of any future
  // tainted-canvas argument — a tainted canvas cannot be read back at all.
  element.crossOrigin = "anonymous";
  element.decoding = "sync";
  element.src = url;

  try {
    if (typeof element.decode === "function") {
      await element.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        element.onload = () => {
          resolve();
        };
        element.onerror = () => {
          reject(new DerivativeError("That photo could not be opened on this device."));
        };
      });
    }
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof DerivativeError
      ? error
      : new DerivativeError("That photo could not be opened on this device.", error);
  }

  return {
    width: element.naturalWidth,
    height: element.naturalHeight,
    source: element,
    release: () => {
      URL.revokeObjectURL(url);
    },
  };
}
