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
  posterFrameTime,
  toHex,
  videoContainerFor,
  type PixelSize,
} from "@partybooth/contracts/capture";
import { capturesDirectory, deleteLocalFile, readLocalBytes } from "./device-store";

import type { MediaSource } from "@partybooth/contracts/media";
import type { SharedRef } from "expo-modules-core/types";
import type { CaptureDraft, DerivativeDraft } from "./types";

/**
 * Anything the manipulator will decode.
 *
 * Widened from `string | ImageRef` because a video poster arrives as a
 * `VideoThumbnail`, which is a sibling of `ImageRef` rather than one of them —
 * both extend `SharedRef<'image'>`, which is exactly what
 * `ImageManipulator.manipulate` accepts. Typing the parameter as what the
 * manipulator takes, rather than as one of the things that happen to satisfy it,
 * is what let the poster path reuse the photo encoder unchanged.
 */
type EncodableImage = string | SharedRef<"image">;

/* -------------------------------------------------------------------------- */
/* Sizing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every number this pipeline encodes at now comes from the contract.
 *
 * `SHARED` is the artefact third parties are served — a photo's `preview`, a
 * video's `poster` — and it is deliberately the *same* on both clients, so a
 * photo taken in the app and one taken on mobile web sit in the same grid at the
 * same size. It used to be two local constants, one here and one in
 * `apps/web/src/lib/upload/video.ts`, holding the same two numbers with nothing
 * keeping them equal.
 */
const NATIVE = DERIVATIVE_PROFILES.native;

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

/** What the recorder handed back, plus what the shutter machine timed. */
export interface SourceVideo {
  /** `file://` path to the clip `recordAsync` wrote, in the **cache** directory. */
  readonly uri: string;
  /**
   * How long it runs.
   *
   * Measured by the shutter state machine rather than read back off the file:
   * `recordAsync` reports only a URI, probing the container costs a decode, and
   * the number the machine has is the number the guest watched count up. It is
   * required — `validateMediaFile` refuses a video grant without one.
   */
  readonly durationSeconds: number;
}

export interface BuildVideoInput {
  readonly eventId: string;
  readonly source: SourceVideo;
  readonly capturedAt?: number | undefined;
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
  source: EncodableImage,
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
 * Byte count and SHA-256 of one local file, from a single read.
 *
 * Hashing a different read from the one that produced the size would make a
 * mismatch possible for no reason at all, and `matchesGrant` on the far side
 * compares both against what the grant authorised.
 */
async function describeLocalFile(uri: string): Promise<{ byteSize: number; checksum: string }> {
  const bytes = await readLocalBytes(uri);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return { byteSize: bytes.byteLength, checksum: toHex(digest) };
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
    NATIVE.uploadMaxEdge,
    NATIVE.uploadQuality,
    known,
  );

  // Built from the original rather than from the camera's file, so the thumbnail
  // is always a picture of what was actually sent.
  const preview = await encodeTo(
    original.uri,
    derivativeFileName(captureId, "thumbnail"),
    NATIVE.thumbnailMaxEdge,
    NATIVE.thumbnailQuality,
    { width: original.width, height: original.height },
  );

  /*
   * The **uploaded** preview — the Sprint 3 carry-over, on the client half.
   *
   * Distinct from the 640 px thumbnail above, which is local-only and always was
   * (`DERIVATIVE_PROFILES`' comment says so). This one goes up under the same
   * `captureId` with `fileRole: "preview"`, and it is what a fellow guest is
   * served when the original is withheld — which is exactly why the grant for it
   * is refused unless `sourceMetadataStripped` is `true` (ADR 0008). Built from
   * the encoded original, so it is provably a picture of what was sent and is
   * provably a re-encode.
   */
  const shared = await encodeTo(
    original.uri,
    derivativeFileName(captureId, "preview"),
    NATIVE.sharedMaxEdge,
    NATIVE.sharedQuality,
    { width: original.width, height: original.height },
  );

  const [originalFile, sharedFile] = await Promise.all([
    describeLocalFile(original.uri),
    describeLocalFile(shared.uri),
  ]);

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
    byteSize: originalFile.byteSize,
    mimeType: DERIVATIVE_MIME_TYPE,
    checksum: originalFile.checksum,
    width: original.width,
    height: original.height,
    capturedAt,
    // Earned, not claimed: every path above ends in a JPEG re-encode.
    sourceMetadataStripped: true,
    derivatives: [
      {
        role: "preview",
        uri: shared.uri,
        byteSize: sharedFile.byteSize,
        mimeType: DERIVATIVE_MIME_TYPE,
        checksum: sharedFile.checksum,
        width: shared.width,
        height: shared.height,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Video                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A still from the clip, encoded as a JPEG we can actually upload.
 *
 * ## Why `expo-video` and not `expo-video-thumbnails`
 *
 * `expo-video-thumbnails` is deprecated in favour of `generateThumbnailsAsync`
 * on `expo-video`'s player, and `expo-video` is a dependency of this screen
 * anyway because it is what plays the clip back. Adding a second, deprecated
 * native module in launch week to do a job the module we already ship does is
 * not a trade worth making.
 *
 * ## The awkward bit
 *
 * `generateThumbnailsAsync` returns a `VideoThumbnail`, which is a **native image
 * reference**, not a file. There are no bytes to hash and nothing to upload. But
 * `VideoThumbnail extends SharedRef<'image'>` and `ImageManipulator.manipulate`
 * takes `string | SharedRef<'image'>`, so the reference goes straight into the
 * same encoder every photograph goes through and comes out the other side as a
 * JPEG on disk with a size and a checksum. That is also what makes the poster a
 * genuine re-encode from decoded pixels rather than a copy of anything — so the
 * `sourceMetadataStripped: true` its grant requires is earned by the same
 * mechanism as a photo's.
 *
 * ## Not frame zero
 *
 * A clip's first frame is very often the lens still adjusting exposure — a grey
 * or blown-out rectangle, which then becomes the thumbnail for the whole
 * evening. Which frame to take instead is `posterFrameTime` in the contract,
 * shared with `apps/web` so the same clip does not get a different thumbnail
 * depending on which app recorded it. This path used to sample a flat 150 ms;
 * the shared rule waits a full second on anything long enough to allow it, which
 * is past the worst of the exposure ramp rather than merely past the start of it.
 *
 * Returns `null` rather than throwing. A missing poster costs a thumbnail; a
 * throw here would cost the video, and a capture with no derivative is never
 * stranded by design (`DERIVATIVE_ROLES_BY_TYPE`: "expected, not required").
 */
async function buildVideoPoster(
  captureId: string,
  videoUri: string,
  durationSeconds: number,
): Promise<DerivativeDraft | null> {
  let player: { release: () => void } | null = null;
  try {
    // Imported on demand. `expo-video` pulls a native player a guest who never
    // records anything should not pay to load, and this matches how the picker
    // is imported on the camera screen.
    const { createVideoPlayer } = await import("expo-video");
    const created = createVideoPlayer({ uri: videoUri });
    player = created;

    const [thumbnail] = await created.generateThumbnailsAsync([posterFrameTime(durationSeconds)], {
      maxWidth: NATIVE.sharedMaxEdge,
    });
    if (thumbnail === undefined) return null;

    const poster = await encodeTo(
      thumbnail,
      derivativeFileName(captureId, "poster"),
      NATIVE.sharedMaxEdge,
      NATIVE.sharedQuality,
      { width: thumbnail.width, height: thumbnail.height },
    );
    const described = await describeLocalFile(poster.uri);

    return {
      role: "poster",
      uri: poster.uri,
      byteSize: described.byteSize,
      mimeType: DERIVATIVE_MIME_TYPE,
      checksum: described.checksum,
      width: poster.width,
      height: poster.height,
    };
  } catch {
    return null;
  } finally {
    // A player holds a decoder. `useVideoPlayer` releases on unmount; one created
    // by hand is ours to release, and leaking one per video at a party is a
    // thermal problem within the hour.
    player?.release();
  }
}

/**
 * Recorded clip → the exact file we are going to send, plus its poster.
 *
 * ## Why this does not re-encode, and why that is still honest
 *
 * Every photo path ends in a JPEG re-encode, which is the *mechanism* by which
 * no EXIF/GPS block reaches storage. A 60-second 1080p clip cannot be re-encoded
 * on a phone in the time a guest will wait, and nothing in the Expo toolchain
 * transcodes video at all — so the mechanism has to be different, and the claim
 * has to be justified differently. It is:
 *
 * - The clip is written by `expo-camera`'s own recorder. Neither
 *   `AVCaptureMovieFileOutput` (iOS) nor `MediaRecorder` (Android) embeds a
 *   location unless the app supplies one, and this app never does.
 * - **The app cannot obtain a location at all.** `app.config.ts` lists
 *   `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` under `blockedPermissions`
 *   on Android and ships no `NSLocation*UsageDescription` on iOS, so there is no
 *   fix to embed even if something asked. That is a structural guarantee rather
 *   than a promise about a code path.
 * - Video **library import is deliberately not built** (the picker on the camera
 *   screen is `mediaTypes: ["images"]`). The one file type that genuinely can
 *   arrive carrying somebody else's GPS trace — a clip from the camera roll —
 *   has no route into this pipeline.
 *
 * So the claim this path makes is now written as two, which is what the contract
 * grew in Sprint 4 (`MetadataClaim`): **`reEncoded: false`** — truthfully,
 * nothing here is transcoded — and **`carriesNoLocation: true`**, justified by
 * the three structural facts above rather than by a mechanism. A single
 * `sourceMetadataStripped: true` used to have to stand for both, which meant
 * this path asserted a re-encode it had not performed in order to get a
 * visibility decision it had honestly earned. The read path asks only about
 * location (`mayServeOriginal`), so the outcome is unchanged and the sentence is
 * now true.
 *
 * The poster **is** a genuine re-encode, which is what matters most: it is the
 * artefact third parties are handed, and its grant would be refused without the
 * claim.
 */
export async function buildVideoCapture(input: BuildVideoInput): Promise<CaptureDraft> {
  const captureId = newCaptureId();
  const capturedAt = input.capturedAt ?? Date.now();
  const { mimeType, extension } = videoContainerFor(input.source.uri);

  /*
   * Move it out of the cache directory first, before anything else can fail.
   *
   * `recordAsync` writes to the cache, which iOS and Android both evict under
   * storage pressure — and a 200 MB clip is exactly what an OS looks at when it
   * needs space. A queue row pointing at an evicted file is a capture that
   * cannot be retried and cannot be explained.
   */
  const target = new DeviceFile(
    capturesDirectory(),
    derivativeFileName(captureId, "original", extension),
  );
  if (target.exists) target.delete();
  new DeviceFile(input.source.uri).moveSync(target);

  const described = await describeLocalFile(target.uri);
  const poster = await buildVideoPoster(captureId, target.uri, input.source.durationSeconds);

  return {
    captureId,
    eventId: input.eventId,
    mediaType: "video",
    // Camera only. There is no video path out of the library — see above.
    mediaSource: "capture",
    uri: target.uri,
    // The poster doubles as the local thumbnail, so "My media" draws the clip
    // rather than a grey box while the bytes are still going up. When the poster
    // could not be made, the row falls back to the video's own URI, which
    // `expo-image` cannot render — and a grey box is the correct outcome there.
    previewUri: poster?.uri ?? target.uri,
    byteSize: described.byteSize,
    mimeType,
    checksum: described.checksum,
    durationSeconds: input.source.durationSeconds,
    capturedAt,
    // Not a re-encode, and says so. See the block comment above: the location
    // promise is structural (no location permission exists on either platform),
    // and it is the location promise that the read path consults.
    sourceMetadataStripped: false,
    sourceCarriesNoLocation: true,
    /*
     * Poster only. A video's `preview` role is a *downscaled muted clip*, which
     * needs a transcoder this platform does not have — so it is not produced,
     * and `projectMedia` falls back to `previewKey ?? posterKey`, serving the
     * poster where a clip would have gone. What that costs is bandwidth on a
     * gallery grid, not visibility: the original is served to everyone because
     * `sourceCarriesNoLocation` above is true. Transcoding is post-launch
     * (PLAN.md → P2).
     */
    derivatives: poster === null ? [] : [poster],
  };
}
