/**
 * Reading a video's real duration out of its own bytes.
 *
 * The 60-second cap was enforced twice and independently zero times. Both checks
 * — `checkGrantEligibility` at grant time and `completeUpload` on the landed
 * object — read a number the **client** supplied: the completion callback in
 * `apps/web/src/app/api/uploadthing/core.ts` forwards `metadata.durationSeconds`,
 * which is copied verbatim off the upload ticket. So a modified client could
 * claim eight seconds and upload a ten-minute recording, and as long as it fitted
 * under the 250 MB size ceiling nothing anywhere disagreed. PLAN.md's "≤ 60 s"
 * was a suggestion with two enforcement points pointing at the same claim.
 *
 * There is no transcoder available to us — Convex's isolate has no native
 * modules, which is the constraint ADR 0004 and ADR 0008 are both built around —
 * but reading a duration does not need one. An MP4 or a QuickTime file is a tree
 * of length-prefixed boxes, and the `mvhd` box near the front of `moov` carries a
 * timescale and a duration in about twenty bytes. Parsing that is arithmetic on a
 * `Uint8Array`: pure, fast, and testable offline against a handful of synthetic
 * bytes, which is the bar everything in this package has to clear.
 *
 * ## What it does not do
 *
 * WebM is not parsed. Its duration lives in an EBML `Segment > Info > Duration`
 * element as a float, behind variable-length integers, and the containers our own
 * clients produce are `video/mp4` and `video/quicktime` — a WebM only reaches
 * storage through a browser that chose it for a library import. An unparseable
 * container answers `undefined`, and the caller's rule for `undefined` is
 * "record that it could not be verified", never "assume it is fine" and never
 * "delete it": deleting a guest's fifty-five-second clip because a parser did not
 * recognise the container is a worse failure at a party than the one this file
 * exists to prevent.
 */

/** How deep into the tree to walk. `moov > mvhd` is two; four is slack. */
const MAX_DEPTH = 4;

/** A box header is 8 bytes, or 16 with a 64-bit `largesize`. */
const HEADER_BYTES = 8;

export interface VideoDurationReading {
  readonly seconds: number;
  /** The container the reading came from, for the audit row. */
  readonly container: "isobmff";
}

/**
 * The duration of an ISO base-media file (MP4, M4V, MOV), or `undefined`.
 *
 * `bytes` does **not** have to be the whole file — that is the point. The caller
 * fetches a prefix with an HTTP range request and, if `moov` turns out to be at
 * the end (a recording that was not written for streaming), a suffix. A prefix
 * that ends mid-box answers `undefined` rather than guessing, so a short read is
 * indistinguishable from an unrecognised file and both are safe.
 */
export function readIsoBmffDuration(bytes: Uint8Array): VideoDurationReading | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mvhd = findBox(view, 0, view.byteLength, "mvhd", 0);
  if (mvhd === undefined) return undefined;

  const seconds = readMvhd(view, mvhd.start, mvhd.end);
  if (seconds === undefined) return undefined;
  return { seconds, container: "isobmff" };
}

interface BoxSpan {
  /** First byte of the payload. */
  readonly start: number;
  /** One past the last byte of the payload. */
  readonly end: number;
}

/**
 * Walk the box tree looking for `type`, descending only into containers.
 *
 * Only `moov` and `trak` are descended into, deliberately. A generic "descend
 * into everything" walker would happily interpret the middle of an `mdat` — the
 * megabytes of actual video — as a box header, and find whatever the compressed
 * frames happened to spell.
 */
function findBox(
  view: DataView,
  from: number,
  until: number,
  type: string,
  depth: number,
): BoxSpan | undefined {
  let offset = from;

  while (offset + HEADER_BYTES <= until) {
    const declared = view.getUint32(offset);
    const name = readType(view, offset + 4);

    let payloadStart = offset + HEADER_BYTES;
    let boxEnd: number;

    if (declared === 1) {
      // 64-bit `largesize`. `getBigUint64` would be exact; a `Number` is precise
      // to 2^53, and a box larger than nine petabytes is not our problem.
      if (payloadStart + 8 > until) return undefined;
      const high = view.getUint32(payloadStart);
      const low = view.getUint32(payloadStart + 4);
      boxEnd = offset + high * 2 ** 32 + low;
      payloadStart += 8;
    } else if (declared === 0) {
      // "To the end of the file" — legal, and only ever the last box.
      boxEnd = until;
    } else {
      boxEnd = offset + declared;
    }

    // A box that claims to end before its own header, or that overflows the
    // buffer we were handed, is either corrupt or a short read. Both stop.
    if (boxEnd <= offset || boxEnd < payloadStart) return undefined;

    if (name === type) return { start: payloadStart, end: Math.min(boxEnd, until) };

    if (depth < MAX_DEPTH && (name === "moov" || name === "trak" || name === "mdia")) {
      const found = findBox(view, payloadStart, Math.min(boxEnd, until), type, depth + 1);
      if (found !== undefined) return found;
    }

    if (boxEnd > until) return undefined;
    offset = boxEnd;
  }

  return undefined;
}

/**
 * `mvhd`: a full box, so one version byte and three flag bytes, then times.
 *
 * - version 0 — creation (4), modification (4), timescale (4), duration (4)
 * - version 1 — creation (8), modification (8), timescale (4), duration (8)
 *
 * A `duration` of `0xFFFFFFFF` (or its 64-bit equivalent) means "unknown", which
 * a still-being-written recording legitimately carries; it answers `undefined`
 * rather than an absurd number of seconds.
 */
function readMvhd(view: DataView, start: number, end: number): number | undefined {
  if (start + 4 > end) return undefined;
  const version = view.getUint8(start);
  const body = start + 4;

  let timescale: number;
  let duration: number;

  if (version === 1) {
    if (body + 28 > end) return undefined;
    timescale = view.getUint32(body + 16);
    const high = view.getUint32(body + 20);
    const low = view.getUint32(body + 24);
    if (high === 0xff_ff_ff_ff && low === 0xff_ff_ff_ff) return undefined;
    duration = high * 2 ** 32 + low;
  } else if (version === 0) {
    if (body + 16 > end) return undefined;
    timescale = view.getUint32(body + 8);
    duration = view.getUint32(body + 12);
    if (duration === 0xff_ff_ff_ff) return undefined;
  } else {
    return undefined;
  }

  if (timescale <= 0 || !Number.isFinite(duration)) return undefined;
  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function readType(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/* -------------------------------------------------------------------------- */
/* What the verifier does with a reading                                      */
/* -------------------------------------------------------------------------- */

export const VIDEO_DURATION_VERDICTS = ["withinCap", "overCap", "unverifiable"] as const;

export type VideoDurationVerdict = (typeof VIDEO_DURATION_VERDICTS)[number];

/**
 * Judge a measured duration against the cap.
 *
 * The tolerance is a second, and it is not slack for a liar: a recorder that
 * overshoots the stop by a few frames, and the rounding between a timescale and
 * a float, both land a genuine sixty-second clip at 60.04. Refusing those would
 * delete real party footage to catch nothing, because the abuse this exists to
 * stop is a ten-minute file declared as eight seconds.
 *
 * `unverifiable` is its own answer rather than a synonym for either of the
 * others. The caller records it and keeps the file: an unrecognised container is
 * a gap in the check, not evidence against the guest.
 */
export function judgeVideoDuration(
  measured: number | undefined,
  maxSeconds: number,
  toleranceSeconds = 1,
): VideoDurationVerdict {
  if (measured === undefined || !Number.isFinite(measured)) return "unverifiable";
  return measured > maxSeconds + toleranceSeconds ? "overCap" : "withinCap";
}
