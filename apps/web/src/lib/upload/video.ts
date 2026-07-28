/**
 * Video on the guest web path: what we can check before sending, and the poster
 * frame we send alongside it.
 *
 * ## What is and is not possible in a browser
 *
 * A photo is re-encoded before it leaves the device, which is what keeps ADR
 * 0004's promise about location metadata. **A video cannot be.** There is no
 * transcoder in a phone browser worth putting on the party-critical path, so the
 * clip that was recorded is the clip that is uploaded, and its original is
 * marked `sourceMetadataStripped: false` — truthfully. The consequence is
 * exactly the one `mayServeOriginal` describes: the submitter and the hosts can
 * play it, and a fellow guest cannot, until a derivative exists.
 *
 * What *can* be produced here is the **poster** — a still frame drawn through a
 * canvas, which is metadata-free for precisely the reason a re-encoded photo is
 * (a bitmap has nowhere to put an EXIF block). So a video's poster is a genuine
 * derivative, claims the re-encode honestly, and is what every third party is
 * shown: the thumbnail in the gallery, the first painted frame in moderation.
 * A video preview *clip* — the other derivative the contract knows about — is
 * not producible here and is simply never sent. `DERIVATIVE_ROLES_BY_TYPE` calls
 * derivatives "expected, not required" for this reason.
 *
 * ## Duration is checked twice, and neither is decoration
 *
 * `MEDIA_LIMITS.video.maxDurationSeconds` is 60. It is checked here, before a
 * grant is asked for, so a guest who recorded ninety seconds is told so
 * immediately rather than after uploading 200 MB over a party's wifi — and it is
 * checked again by Convex, which is the one that counts.
 *
 * ## Shape of this module
 *
 * Same arrangement as `derivative.ts`, and for the same reason: the arithmetic
 * is pure and directly tested, and everything that touches a `<video>` element
 * sits behind {@link VideoRuntime}, which the tests replace with a fake. The
 * frame is handed to `DerivativeRuntime.encode` — the very canvas path photos
 * use — because an `HTMLVideoElement` is a `CanvasImageSource` and a second
 * encoder would be a second place for the white-background and quality
 * decisions to drift.
 */

import {
  fitWithin,
  MEDIA_LIMITS,
  posterFrameTime,
  validateMediaFile,
  VIDEO_MAX_DURATION_SECONDS,
} from "@/lib/contracts";
import {
  DerivativeError,
  DERIVATIVE_POLICY,
  derivativeFileName,
  type DecodedImage,
  type DerivativeRuntime,
  type Dimensions,
} from "@/lib/upload/derivative";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export interface PosterPolicy {
  readonly maxEdge: number;
  readonly quality: number;
  readonly mimeType: string;
  readonly extension: string;
}

/**
 * The poster's profile — the contract's `shared` tier, not a local constant.
 *
 * A poster is a derivative like any other: the still a third party is served in
 * a gallery, in moderation and on the slideshow before playback starts. So it
 * gets the same size and quality as a photo's `preview`, and it gets them from
 * the same place `apps/mobile` gets them.
 *
 * These two numbers used to be written here *and* in `apps/mobile`'s
 * `media-pipeline.ts` — the same 1280 at 0.8, twice, with nothing keeping them
 * equal. They land a typical frame around 250–400 KB, comfortably inside
 * `DERIVATIVE_LIMITS.image` (2 MiB), which is the ceiling a derivative grant is
 * held to, with room for a 4K source frame that compresses badly.
 */
export const POSTER_POLICY: PosterPolicy = {
  maxEdge: DERIVATIVE_POLICY.sharedMaxEdge,
  quality: DERIVATIVE_POLICY.sharedQuality,
  mimeType: DERIVATIVE_POLICY.outputMimeType,
  extension: DERIVATIVE_POLICY.outputExtension,
};

/** What the file input offers. Kept next to `MEDIA_LIMITS`' own list. */
export const VIDEO_INPUT_ACCEPT = "video/*";

/* -------------------------------------------------------------------------- */
/* Arithmetic                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where in the clip to grab the still — the contract's rule, shared with the app.
 *
 * Re-exported rather than reimplemented: `apps/mobile` used to sample a flat
 * 150 ms and this module a second in, which meant the same clip got a different
 * thumbnail depending on which app recorded it.
 */
export { posterFrameTime };

export function planPosterSize(
  source: Dimensions,
  policy: PosterPolicy = POSTER_POLICY,
): Dimensions {
  return fitWithin(source, policy.maxEdge);
}

export function posterFileName(captureId: string): string {
  return derivativeFileName(captureId, "poster");
}

/**
 * Is this clip sendable at all?
 *
 * A thin wrapper over `validateMediaFile` so the pre-checks a guest sees are the
 * rules Convex enforces, worded identically. Kept as its own function because
 * the capture panel needs to run it in two halves: the size check before the
 * file is opened at all, and the duration check only after the metadata has been
 * read.
 */
export function checkVideoFile(candidate: {
  readonly byteSize: number;
  readonly mimeType: string;
  readonly durationSeconds?: number;
}): { ok: true } | { ok: false; message: string } {
  const result = validateMediaFile({
    mediaType: "video",
    byteSize: candidate.byteSize,
    mimeType: candidate.mimeType,
    ...(candidate.durationSeconds === undefined
      ? {}
      : { durationSeconds: candidate.durationSeconds }),
  });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

/**
 * Does this browser claim it can play what the guest picked?
 *
 * Advisory only — `MEDIA_LIMITS.video.mimeTypes` is the rule and Convex applies
 * it. This exists because a file the *local* `<video>` element cannot open is a
 * file we cannot take a poster from, and saying so before the upload is kinder
 * than a silent posterless clip.
 */
export function isProbablySupportedVideo(mimeType: string): boolean {
  return (MEDIA_LIMITS.video.mimeTypes as readonly string[]).includes(mimeType);
}

/**
 * "1:04" — for a duration chip on the capture card.
 *
 * The contract's, re-exported. `apps/mobile` had a byte-for-byte identical
 * `formatClipDuration`; both now come from one place.
 */
export { formatDuration } from "@partybooth/contracts/copy";

export const MAX_VIDEO_SECONDS = VIDEO_MAX_DURATION_SECONDS;

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

export interface OpenedVideo extends Dimensions {
  readonly durationSeconds: number;
  /** Seek, settle, and hand the frame over as something a canvas can draw. */
  frameAt(seconds: number): Promise<DecodedImage>;
  release(): void;
}

export interface VideoRuntime {
  open(blob: Blob): Promise<OpenedVideo>;
}

export interface VideoFacts {
  readonly durationSeconds: number;
  /** The source clip's pixel size, as reported by the decoder. */
  readonly dimensions: Dimensions;
  readonly poster: Blob;
  readonly posterDimensions: Dimensions;
}

/**
 * Read a clip's metadata and take its poster.
 *
 * Throws {@link DerivativeError} on anything that goes wrong, including a clip
 * that is too long — the message is the contract's own, so the sentence a guest
 * reads here is the sentence Convex would have sent back.
 */
export async function buildVideoFacts(
  file: Blob,
  video: VideoRuntime,
  encoder: DerivativeRuntime,
  policy: PosterPolicy = POSTER_POLICY,
): Promise<VideoFacts> {
  let opened: OpenedVideo;
  try {
    opened = await video.open(file);
  } catch (error) {
    throw new DerivativeError("That video could not be opened on this device.", error);
  }

  try {
    const { durationSeconds } = opened;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new DerivativeError("That video's length could not be read on this device.");
    }

    // Checked here rather than after the poster so a ninety-second clip costs a
    // seek, not a full decode-and-encode.
    const limits = checkVideoFile({
      byteSize: file.size,
      mimeType: file.type,
      durationSeconds,
    });
    if (!limits.ok) throw new DerivativeError(limits.message);

    const dimensions: Dimensions = { width: opened.width, height: opened.height };
    const posterDimensions = planPosterSize(dimensions, policy);

    const frame = await opened.frameAt(posterFrameTime(durationSeconds));
    let poster: Blob;
    try {
      poster = await encoder.encode(frame, posterDimensions, policy.mimeType, policy.quality);
    } finally {
      frame.release();
    }

    if (poster.size <= 0) {
      throw new DerivativeError("That video's thumbnail came back empty.");
    }

    return { durationSeconds, dimensions, poster, posterDimensions };
  } catch (error) {
    if (error instanceof DerivativeError) throw error;
    throw new DerivativeError("That video could not be prepared for upload.", error);
  } finally {
    opened.release();
  }
}

/* -------------------------------------------------------------------------- */
/* The browser implementation                                                 */
/* -------------------------------------------------------------------------- */

/** Longest we will wait for a decoder to answer, per step. */
const VIDEO_STEP_TIMEOUT_MS = 15_000;

/**
 * A real `<video>` element fed an object URL.
 *
 * Four attributes are load-bearing rather than cosmetic:
 *
 * - `muted` **and** `playsInline`: iOS refuses to decode a video that would
 *   otherwise take over the screen, and refuses to autoplay one with audio. A
 *   video that never decodes never paints a frame, and a canvas drawn from it is
 *   a black rectangle.
 * - `preload="metadata"`: the duration and dimensions are the first thing needed
 *   and are worth a round trip on their own; the frame comes after.
 * - `crossOrigin` is deliberately **not** set — the source is a same-origin blob
 *   URL, and a tainted canvas cannot be read back at all, which would fail as a
 *   silent black poster rather than as an error.
 *
 * The `play()`/`pause()` dance around the seek is the iOS workaround: some
 * versions will not render a frame into a canvas until the element has been
 * given permission to play at least once. It is wrapped in a `catch` because on
 * every other engine the promise rejects harmlessly and the frame is already
 * there.
 */
export const browserVideoRuntime: VideoRuntime = {
  async open(blob: Blob): Promise<OpenedVideo> {
    const url = URL.createObjectURL(blob);
    const element = document.createElement("video");
    element.muted = true;
    element.defaultMuted = true;
    element.playsInline = true;
    element.preload = "metadata";
    element.src = url;

    const release = (): void => {
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };

    try {
      await once(element, "loadedmetadata", VIDEO_STEP_TIMEOUT_MS);
    } catch (error) {
      release();
      throw error;
    }

    return {
      durationSeconds: element.duration,
      width: element.videoWidth,
      height: element.videoHeight,
      release,

      async frameAt(seconds: number): Promise<DecodedImage> {
        try {
          await element.play();
          element.pause();
        } catch {
          // Autoplay refused, or already painted. Both are fine — the seek below
          // is what actually produces the frame on every engine that allows it.
        }

        const target = Math.min(Math.max(0, seconds), Math.max(0, element.duration - 0.05));
        if (Math.abs(element.currentTime - target) > 0.01) {
          element.currentTime = target;
          await once(element, "seeked", VIDEO_STEP_TIMEOUT_MS);
        }

        return {
          width: element.videoWidth,
          height: element.videoHeight,
          source: element,
          // The element is released by `release()` once, when the whole clip is
          // done with; a per-frame release would tear down the decoder between
          // the seek and the draw.
          release: () => undefined,
        };
      },
    };
  },
};

/** One event, or an error — never a promise that hangs on a wedged decoder. */
function once(element: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (outcome: () => void): void => {
      element.removeEventListener(event, onEvent);
      element.removeEventListener("error", onError);
      clearTimeout(timer);
      outcome();
    };
    const onEvent = (): void => {
      done(resolve);
    };
    const onError = (): void => {
      done(() => {
        reject(new DerivativeError("That video could not be read on this device."));
      });
    };
    const timer = setTimeout(() => {
      done(() => {
        reject(new DerivativeError("That video took too long to open on this device."));
      });
    }, timeoutMs);

    element.addEventListener(event, onEvent, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}
