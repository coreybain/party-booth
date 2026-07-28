import type { RandomBytes } from "./codes";
import { captureIdSchema } from "./schemas";

/**
 * The client-side capture pipeline — the arithmetic both `apps/web` and
 * `apps/mobile` run between "the guest pressed the button" and "there is a file
 * to ask for a grant for".
 *
 * Everything here is pure. There is no canvas, no `ImageManipulator`, no
 * `crypto` and no file system: the platform pieces stay in the apps, behind
 * their own runtime seams, and what lives in this module is the part that has to
 * be **the same on both**. Before it moved here, each client had its own
 * `fitWithin`, its own hex encoder and its own capture-id generator, and the two
 * generators produced ids of different shapes.
 *
 * ## Why this file is where the privacy promise is kept
 *
 * PLAN.md requires location metadata stripped from anything served as a
 * derivative, and [ADR 0004](../../../docs/adr/0004-private-upload-pipeline.md)
 * §7 chooses to do it **at capture, by re-encoding**, on the client, rather than
 * server-side. That is not a performance decision — server-side stripping would
 * mean writing the GPS-bearing original to storage first, which is precisely the
 * artefact the promise says never exists.
 *
 * A re-encode drops metadata because it has nowhere to put it. Decoding a JPEG
 * yields a bitmap: pixels and nothing else, so the APP1/EXIF segment carrying
 * the GPS fix, the device serial and the capture time is gone at that point.
 * Encoding from the bitmap writes a fresh file whose only APP segments are the
 * ones the encoder emits. Nothing is *removed*; the container is never created.
 *
 * Two consequences worth stating because they are easy to get wrong:
 *
 * - **Orientation must survive.** EXIF `Orientation` is metadata too, so a naive
 *   re-encode of a phone's portrait photo produces a sideways one. Each client's
 *   decode step has to bake rotation into the pixels.
 * - **The claim is recorded, not assumed.** `sourceMetadataStripped` on the
 *   grant is only ever set from the value the pipeline actually produced. A
 *   client too old to re-encode marks its upload unstripped; it does not lie.
 *
 * PLAN.md also defines "original" as the **final submitted capture**, which
 * makes the re-encode the original. There is no earlier artefact retained
 * anywhere, on the device or in storage.
 */

/**
 * Re-exported so a client that only mints capture ids has one import. It is
 * `./codes`' type — the same seam event codes and invite tokens are generated
 * through — because there is one notion of "where randomness comes from" in this
 * repo and it should stay that way.
 */
export type { RandomBytes };

/* -------------------------------------------------------------------------- */
/* Sizing                                                                     */
/* -------------------------------------------------------------------------- */

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Scale `source` to fit inside a `maxEdge` square, preserving aspect ratio.
 *
 * Never upscales — a 300 px photo stays 300 px rather than becoming a blurry
 * 2560 px one that costs thirty times as much to send. Rounds to whole pixels
 * and floors at 1, because a panorama scaled to fit 480 px can otherwise produce
 * a height of 0, and both a canvas and a native encoder throw on that.
 *
 * A degenerate input (zero, negative, `NaN`, `Infinity`) returns 1×1 rather than
 * throwing. The callers are both inside an async capture path where the
 * alternative to a tiny image is a guest staring at a spinner that never ends.
 */
export function fitWithin(source: PixelSize, maxEdge: number): PixelSize {
  const longest = Math.max(source.width, source.height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 1, height: 1 };
  if (longest <= maxEdge) {
    return {
      width: Math.max(1, Math.round(source.width)),
      height: Math.max(1, Math.round(source.height)),
    };
  }

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/**
 * Would {@link fitWithin} actually change anything?
 *
 * Native image manipulators resample even when asked for the size they were
 * given, which on a low-end Android is a visible pause for no gain. `apps/mobile`
 * uses this to skip the resize operation entirely; `apps/web` re-encodes
 * regardless, because on the web the re-encode *is* the metadata strip and
 * skipping it would skip the privacy invariant with it.
 */
export function needsResize(source: PixelSize, maxEdge: number): boolean {
  const longest = Math.max(source.width, source.height);
  if (!Number.isFinite(longest) || longest <= 0) return false;
  return longest > maxEdge;
}

/* -------------------------------------------------------------------------- */
/* Derivative profiles                                                        */
/* -------------------------------------------------------------------------- */

export interface DerivativeProfile {
  /** Longest edge of the file actually uploaded — the submitted original. */
  readonly uploadMaxEdge: number;
  readonly uploadQuality: number;
  /**
   * Longest edge of the **shared** derivative — a photo's `preview`, a video's
   * `poster`. Uploaded, and the artefact third parties are served.
   */
  readonly sharedMaxEdge: number;
  readonly sharedQuality: number;
  /** Longest edge of the local thumbnail. Never uploaded — see below. */
  readonly thumbnailMaxEdge: number;
  readonly thumbnailQuality: number;
  /** The only MIME type either pipeline produces. */
  readonly outputMimeType: "image/jpeg";
  readonly outputExtension: "jpg";
}

/**
 * How big, and how good — per platform, in one place.
 *
 * The two profiles are **deliberately different**, and the difference is set by
 * the encoder each platform has rather than by taste:
 *
 * - `web` re-encodes through a `<canvas>`. Mobile Safari caps total canvas area
 *   (around 16.7 megapixels on iOS) and silently produces a blank bitmap past
 *   it, so the ceiling has to leave real headroom. 2560 on the long edge is
 *   4.9 Mpx — a 4K-ish slideshow frame with room to crop, landing a typical
 *   photo around 700 KB.
 * - `native` re-encodes through `expo-image-manipulator`, which has no such
 *   limit, so it keeps more detail. 4096 is more than a 4K slideshow can show
 *   and still comfortably inside the contract's 20 MB photo cap from a
 *   48-megapixel sensor.
 *
 * Both are far below `MEDIA_LIMITS.photo.maxBytes` on purpose. An uncapped
 * modern phone can produce a file that `validateMediaFile` refuses *after* the
 * guest has already waited for it to encode, and every megabyte past what a
 * slideshow can show is a second of party wifi and another chance to drop.
 *
 * ## Three tiers, and why the middle one exists
 *
 * - `upload*` — the submitted **original**. Platform-specific, for the encoder
 *   reasons above.
 * - `shared*` — the uploaded **derivative**: a photo's `preview`, a video's
 *   `poster`. This is what a fellow guest's gallery renders, what a video paints
 *   before playback, and — via `projectMedia`'s `previewKey ?? posterKey` — the
 *   fallback anywhere the original is withheld.
 * - `thumbnail*` — a **local-only** thumbnail. Never uploaded. It exists so a
 *   guest sees their own photo the instant they press send rather than a grey
 *   box, and so a failed upload still looks like the picture it is.
 *
 * The middle tier is **identical on both platforms**, deliberately: it is the
 * artefact other people are served, so a photo taken on the app and one taken on
 * mobile web should look the same in the same grid. Both clients had
 * independently landed on 1280 px at q0.8 in their own files — the same two
 * numbers, in two places, free to drift — which is why they are here now.
 *
 * 1280 at q0.8 puts a typical frame around 250–400 KB, comfortably inside
 * `DERIVATIVE_LIMITS.image.maxBytes` (2 MiB) with room for a busy, high-detail
 * photograph. That cap is not a suggestion — `checkGrantEligibility` refuses the
 * grant over it — and its tightness is itself part of the privacy argument: a
 * 12-megapixel camera JPEG with its EXIF block intact does not fit in two
 * megabytes, which is the cheapest available corroboration that a derivative
 * really is a re-encode.
 *
 * The thumbnail tier is **not** a substitute for the shared one. 480–640 px is
 * visibly soft on a modern phone's grid and embarrassing on a tablet; it is
 * drawn at 64 px in a list and sized for that.
 */
export const DERIVATIVE_PROFILES = {
  web: {
    uploadMaxEdge: 2560,
    uploadQuality: 0.85,
    sharedMaxEdge: 1280,
    sharedQuality: 0.8,
    thumbnailMaxEdge: 480,
    thumbnailQuality: 0.6,
    outputMimeType: "image/jpeg",
    outputExtension: "jpg",
  },
  native: {
    uploadMaxEdge: 4096,
    uploadQuality: 0.92,
    sharedMaxEdge: 1280,
    sharedQuality: 0.8,
    thumbnailMaxEdge: 640,
    thumbnailQuality: 0.6,
    outputMimeType: "image/jpeg",
    outputExtension: "jpg",
  },
} as const satisfies Record<string, DerivativeProfile>;

export type DerivativePlatform = keyof typeof DERIVATIVE_PROFILES;

/**
 * JPEG, always, whatever came in.
 *
 * HEIC is the one that matters: an iPhone on default settings hands both
 * `input[capture]` and the photo picker a `.heic`, which `MEDIA_LIMITS` does
 * accept — but which roughly nothing else can display, including the organiser's
 * laptop. The re-encode we were doing anyway for the metadata strip normalises
 * the format for free. WebP would be smaller and is not universally encodable on
 * either platform; this is not the week to find out where.
 */
export const DERIVATIVE_MIME_TYPE = "image/jpeg";

/** The extension that goes with {@link DERIVATIVE_MIME_TYPE}. */
export const DERIVATIVE_EXTENSION = "jpg";

/**
 * The artefacts a client writes to disk for one capture.
 *
 * Three of these four are a `MediaFileRole` spelled the same way, on
 * purpose: `derivativeFileName(id, "preview")` names the file that is uploaded
 * with `fileRole: "preview"`, and the alignment is what stops the two vocabularies
 * drifting. `thumbnail` is the odd one out precisely *because* it has no role —
 * it is local-only and never uploaded, and calling it "preview" (as the profile
 * fields once did) is what made the two meanings collide in the first place.
 */
export const DERIVATIVE_FILE_KINDS = ["original", "thumbnail", "preview", "poster"] as const;

export type DerivativeKind = (typeof DERIVATIVE_FILE_KINDS)[number];

/**
 * Where a capture's files live on disk, for the client that keeps them there.
 *
 * Named from the `captureId` so a sweep that deletes files for forgotten queue
 * rows needs no index, and so a crash between "file written" and "row persisted"
 * leaves something a later sweep can recognise as an orphan rather than a
 * mystery.
 *
 * `extension` defaults to JPEG because every *image* either pipeline produces is
 * one ({@link DERIVATIVE_MIME_TYPE}). It is a parameter because a video's
 * original is not: `expo-camera` writes QuickTime on iOS and MP4 on Android, and
 * hardcoding `.jpg` here is what pushed `apps/mobile` into keeping a second,
 * private naming function — so the two clients named the same artefact
 * differently and neither could tell.
 */
export function derivativeFileName(
  captureId: string,
  kind: DerivativeKind,
  extension: string = DERIVATIVE_EXTENSION,
): string {
  return `${captureId}-${kind}.${normaliseExtension(extension)}`;
}

/** Lower-case, no leading dot — `".MOV"` and `"mov"` name the same file. */
function normaliseExtension(extension: string): string {
  const trimmed = extension.trim().replace(/^\.+/, "").toLowerCase();
  return trimmed === "" ? DERIVATIVE_EXTENSION : trimmed;
}

/**
 * The container `expo-camera`/`MediaRecorder` wrote, from the path it wrote to.
 *
 * Guessing from the extension rather than sniffing the file is correct here
 * because *we* wrote the file: the extension is the recorder's, not a name a
 * guest chose. iOS writes QuickTime and Android writes MP4, both of which are in
 * `MEDIA_LIMITS.video.mimeTypes`. Anything unrecognised falls back to MP4, which
 * is what a server-side default would assume anyway.
 *
 * Shared rather than per-client because the answer decides the `mimeType` on the
 * upload ticket, and `checkTicketAgainstGrant` refuses a ticket whose MIME type
 * disagrees with the grant's — so two clients guessing differently is a class of
 * refusal nobody could debug from the outside.
 */
export function videoContainerFor(uri: string): { mimeType: string; extension: string } {
  const extension = normaliseExtension(uri.split(".").pop() ?? "");
  if (extension === "mov" || extension === "qt") return { mimeType: "video/quicktime", extension };
  if (extension === "webm") return { mimeType: "video/webm", extension };
  return { mimeType: "video/mp4", extension: "mp4" };
}

/* -------------------------------------------------------------------------- */
/* Posters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where in a clip to grab the still that represents it.
 *
 * **Not frame zero.** The first frame of a phone recording is very often the
 * lens still adjusting exposure — a black or blown-out rectangle — and that
 * frame then represents the video everywhere it appears, for the whole evening.
 *
 * One second in, or the midpoint of anything shorter, so it is never past the
 * end: a seek beyond `duration` settles wherever the decoder feels like, which
 * is a different frame on every device. Both clients used to answer this
 * question separately (one at a flat 150 ms, one at this rule), which meant the
 * same clip got a different thumbnail depending on which app recorded it.
 */
export function posterFrameTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(1, durationSeconds / 2);
}

/* -------------------------------------------------------------------------- */
/* Hex                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Lower-case hex, which is the only shape `checksumSchema` accepts.
 *
 * Written by hand rather than via `Buffer`: Hermes has no Node `Buffer`, and a
 * polyfill for sixteen characters of lookup table is not a trade worth making.
 * Accepts an `ArrayBuffer` because that is what `crypto.subtle.digest` and
 * `expo-crypto`'s `digest` both return.
 */
export function toHex(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Capture ids                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Capture ids are the thing that makes an upload idempotent.
 *
 * One id per photo, generated on the device the moment the guest takes it and
 * **reused for every retry of that photo**. That is the whole mechanism: Convex
 * keys a media row on `(eventId, captureId)`, so a retry after a dropped
 * connection reconciles onto the row already there instead of creating a second
 * copy of the same picture. Minting a fresh id on retry would turn every flaky
 * upload into a duplicate in the host's moderation queue.
 *
 * Two properties the id needs, and one it must not have:
 *
 * - It has to satisfy `captureIdSchema` (8–64 characters of `[A-Za-z0-9_-]`),
 *   checked by {@link isValidCaptureId} so a bad generator fails in a unit test
 *   rather than as a validation error on a phone at a party.
 * - It has to be **unguessable**. The `by_event_and_capture` index is scoped to
 *   the event, not to the person, so two guests at one party can name the same
 *   id. Convex refuses the collision rather than mixing them up, but a
 *   predictable id would turn "refuses the collision" into a guest being able to
 *   block another guest's upload by guessing it. 128 bits of CSPRNG output makes
 *   that not a thing.
 * - It must not encode anything. No timestamp, no user id, no device hint: it
 *   travels in audit metadata, so it should carry no more meaning than a
 *   coat-check ticket.
 */

/** Enough bytes that a collision needs a birthday paradox, not a guess. */
export const CAPTURE_ID_BYTES = 16;

/*
 * The CSPRNG is injected, using the same `RandomBytes` seam `./codes` defines
 * for event codes and invite tokens. There is deliberately no `Math.random()`
 * fallback anywhere: a runtime without a CSPRNG also cannot hash the file, so
 * one clear failure beats two vague ones. `apps/web` passes
 * `crypto.getRandomValues`; `apps/mobile` passes `expo-crypto`'s, because
 * Hermes does not guarantee a global `crypto`.
 */

/**
 * Which client minted an id, for a human reading an audit row at 1 a.m.
 * wondering whether a failing upload came from the app or from mobile web.
 * It carries no meaning to any code, and nothing may ever branch on it.
 */
export const CAPTURE_ID_PREFIXES = { web: "w", native: "m" } as const;

export type CaptureIdPrefix = (typeof CAPTURE_ID_PREFIXES)[DerivativePlatform];

export function newCaptureId(prefix: CaptureIdPrefix, random: RandomBytes): string {
  return `${prefix}${toHex(random(CAPTURE_ID_BYTES))}`;
}

/** The same rule Convex applies, so a generator bug is caught locally. */
export function isValidCaptureId(value: string): boolean {
  return captureIdSchema.safeParse(value).success;
}
