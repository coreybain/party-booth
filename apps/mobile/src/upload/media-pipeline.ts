/**
 * Camera frame (or library pick) → the exact file we are going to send.
 *
 * This is the impure half of `./derivative`, and it is where the privacy
 * invariant actually happens. Every path through it ends in
 * `…renderAsync().saveAsync({ format: JPEG })`, which writes a **new** JPEG from
 * decoded pixels. There is no EXIF block in the output, therefore no GPS fix, no
 * device serial, no lens data and no capture time other than the one we choose
 * to send. That is ADR 0004 §7's "strip location metadata client-side, at
 * capture, by re-encoding", implemented rather than asserted — and
 * `sourceMetadataStripped: true` on the resulting draft is the claim the server
 * records alongside it.
 *
 * Two consequences worth stating plainly:
 *
 * - **The re-encode is the original.** PLAN.md defines "original" as the final
 *   submitted capture, so nothing earlier is retained anywhere. The camera's own
 *   file is never uploaded and is deleted as soon as the derivative exists.
 * - **`byteSize` and `checksum` come from the same read.** They describe one
 *   array of bytes, so a grant issued against them cannot be satisfied by a
 *   different file — which is exactly what `matchesGrant` checks on the far side.
 *
 * Everything here throws on failure. The queue decides what a failure means; a
 * pipeline that quietly returned a half-made draft would put a broken file into
 * a durable queue, which is the one place it must not go.
 */

import * as Crypto from "expo-crypto";
import { File as DeviceFile } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import {
  CAPTURE_ID_PREFIXES,
  DERIVATIVE_MIME_TYPE,
  DERIVATIVE_PROFILES,
  derivativeFileName,
  fitWithin,
  needsResize,
  newCaptureId as mintCaptureId,
  toHex,
  type PixelSize,
} from "@partybooth/contracts/capture";
import { capturesDirectory, deleteLocalFile, readLocalBytes } from "./device-store";

import type { MediaSource } from "@partybooth/contracts/media";
import type { ImageRef } from "expo-image-manipulator";
import type { CaptureDraft } from "./types";

/** A fresh id for one capture. Stable for its whole life, retries included. */
export function newCaptureId(): string {
  return mintCaptureId(CAPTURE_ID_PREFIXES.native, (length: number) =>
    Crypto.getRandomValues(new Uint8Array(length)),
  );
}

export interface SourceImage {
  readonly uri: string;
  /** From `takePictureAsync` / the picker asset. Saves a decode when present. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface BuildCaptureInput {
  readonly eventId: string;
  readonly source: SourceImage;
  readonly mediaSource: MediaSource;
  readonly capturedAt?: number | undefined;
  /**
   * Delete the source file once the derivative exists.
   *
   * True for the camera, whose output is ours and is a duplicate the moment the
   * re-encode lands. False for the library, where the source is the guest's own
   * photo — or, on iOS, a copy the system made and also owns.
   */
  readonly discardSource?: boolean | undefined;
}

interface EncodedImage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Encode one image at a target size and move it into the durable directory.
 *
 * `known` is an optimisation, not a shortcut: with dimensions in hand the resize
 * is decided before anything is decoded, and without them the image is decoded
 * once and the *decoded reference* is re-manipulated rather than the file being
 * read a second time.
 *
 * The manipulator writes to the cache directory, which iOS and Android both
 * evict under storage pressure. A queue that survives a restart but whose files
 * do not is worse than no queue at all, so every derivative is moved into the
 * document directory before its path is recorded anywhere.
 */
async function encodeTo(
  source: string | ImageRef,
  fileName: string,
  maxEdge: number,
  quality: number,
  known: PixelSize | null,
): Promise<EncodedImage> {
  let context = ImageManipulator.manipulate(source);
  let size = known;

  if (size === null) {
    const probed = await context.renderAsync();
    size = { width: probed.width, height: probed.height };
    context = ImageManipulator.manipulate(probed);
  }

  // Skipped when nothing would change: the manipulator resamples even when
  // handed the size it already has, which on a low-end Android is a visible
  // pause for no gain. The re-encode below still happens regardless — that is
  // the metadata strip, not an optimisation.
  if (needsResize(size, maxEdge)) {
    const fitted = fitWithin(size, maxEdge);
    context.resize({ width: fitted.width, height: fitted.height });
  }

  const rendered = await context.renderAsync();
  // JPEG is not an inherited default here — it is the mechanism. PNG would also
  // drop EXIF, and would multiply the size of a photograph doing it.
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality });
  return moveIntoPlace(saved, fileName);
}

function moveIntoPlace(result: EncodedImage, fileName: string): EncodedImage {
  const target = new DeviceFile(capturesDirectory(), fileName);
  // A retaken capture reuses nothing (ids are fresh), so an existing file here
  // means a previous attempt died between writing and recording. Overwrite it.
  if (target.exists) target.delete();
  new DeviceFile(result.uri).moveSync(target);
  return { uri: target.uri, width: result.width, height: result.height };
}

/**
 * Build the submitted original and its local thumbnail, and describe them.
 *
 * The returned draft is everything `media.requestUploadGrant` needs, plus
 * everything the queue needs to retry later without the camera being involved
 * again — which is what makes a retry after a restart possible at all.
 */
export async function buildPhotoCapture(input: BuildCaptureInput): Promise<CaptureDraft> {
  const captureId = newCaptureId();
  const capturedAt = input.capturedAt ?? Date.now();

  const known =
    input.source.width !== undefined && input.source.height !== undefined
      ? { width: input.source.width, height: input.source.height }
      : null;

  const original = await encodeTo(
    input.source.uri,
    derivativeFileName(captureId, "original"),
    DERIVATIVE_PROFILES.native.uploadMaxEdge,
    DERIVATIVE_PROFILES.native.uploadQuality,
    known,
  );

  // Built from the original rather than from the camera's file, so the thumbnail
  // is always a picture of what was actually sent.
  const preview = await encodeTo(
    original.uri,
    derivativeFileName(captureId, "preview"),
    DERIVATIVE_PROFILES.native.previewMaxEdge,
    DERIVATIVE_PROFILES.native.previewQuality,
    { width: original.width, height: original.height },
  );

  // One read, two facts. Hashing a different read from the one that produced the
  // size would make a mismatch possible for no reason at all.
  const bytes = await readLocalBytes(original.uri);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);

  if (input.discardSource === true) {
    // Best-effort: an undeleted camera temp file is untidy, not unsafe, and must
    // never be the reason a capture fails to queue.
    await deleteLocalFile(input.source.uri);
  }

  return {
    captureId,
    eventId: input.eventId,
    mediaType: "photo",
    mediaSource: input.mediaSource,
    uri: original.uri,
    previewUri: preview.uri,
    byteSize: bytes.byteLength,
    mimeType: DERIVATIVE_MIME_TYPE,
    checksum: toHex(digest),
    width: original.width,
    height: original.height,
    capturedAt,
    // Earned, not claimed: every path above ends in a JPEG re-encode.
    sourceMetadataStripped: true,
  };
}
