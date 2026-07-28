import { describe, expect, it } from "vitest";

import { judgeVideoDuration, readIsoBmffDuration } from "./video";

/**
 * The duration check that is finally independent of the client.
 *
 * Both existing enforcement points read a number the client supplied — the
 * completion callback forwards the upload ticket's own `durationSeconds` — so a
 * modified client could claim eight seconds and upload ten minutes. These pin
 * the parser that reads the number out of the file's own bytes instead.
 *
 * The fixtures are built here rather than checked in: a synthetic `moov`/`mvhd`
 * is twenty bytes of arithmetic, and a binary fixture in a repository is a thing
 * nobody can read in a review.
 */

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A version-0 `mvhd` payload: version+flags, two times, timescale, duration. */
function mvhdV0(timescale: number, duration: number): Uint8Array {
  const payload = new Uint8Array(4 + 16);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 0);
  view.setUint32(4 + 8, timescale);
  view.setUint32(4 + 12, duration);
  return payload;
}

function mvhdV1(timescale: number, duration: number): Uint8Array {
  const payload = new Uint8Array(4 + 28);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 1);
  view.setUint32(4 + 16, timescale);
  view.setUint32(4 + 20, Math.floor(duration / 2 ** 32));
  view.setUint32(4 + 24, duration >>> 0);
  return payload;
}

const FTYP = box("ftyp", new Uint8Array(8));

describe("readIsoBmffDuration", () => {
  it("reads a version-0 mvhd through its moov", () => {
    const file = concat(FTYP, box("moov", box("mvhd", mvhdV0(600, 600 * 12))));
    expect(readIsoBmffDuration(file)?.seconds).toBeCloseTo(12);
  });

  it("reads a version-1 mvhd, where the duration is 64-bit", () => {
    const file = concat(FTYP, box("moov", box("mvhd", mvhdV1(1000, 1000 * 45))));
    expect(readIsoBmffDuration(file)?.seconds).toBeCloseTo(45);
  });

  it("finds the truth even when the ticket lies", () => {
    // The whole point: ten minutes on disc, whatever the client declared.
    const file = concat(FTYP, box("moov", box("mvhd", mvhdV0(1000, 1000 * 600))));
    expect(readIsoBmffDuration(file)?.seconds).toBeCloseTo(600);
  });

  it("does not walk into mdat, where the frames spell whatever they spell", () => {
    // Four bytes that read as a plausible box header, buried in media data.
    const decoy = box("mdat", concat(new Uint8Array([0, 0, 0, 24]), new Uint8Array(20).fill(0x6d)));
    expect(readIsoBmffDuration(concat(FTYP, decoy))).toBeUndefined();
  });

  it("answers undefined on a short read rather than guessing", () => {
    const file = concat(FTYP, box("moov", box("mvhd", mvhdV0(600, 6000))));
    expect(readIsoBmffDuration(file.slice(0, file.length - 6))).toBeUndefined();
  });

  it("answers undefined for a container it does not know", () => {
    expect(
      readIsoBmffDuration(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])),
    ).toBeUndefined();
  });

  it("answers undefined for an unknown duration rather than an absurd one", () => {
    const file = concat(FTYP, box("moov", box("mvhd", mvhdV0(600, 0xff_ff_ff_ff))));
    expect(readIsoBmffDuration(file)).toBeUndefined();
  });
});

describe("judgeVideoDuration", () => {
  it("passes a clip inside the cap", () => {
    expect(judgeVideoDuration(12, 60)).toBe("withinCap");
  });

  it("tolerates a recorder that overshoots the stop", () => {
    // A genuine sixty-second clip lands at 60.04 between a timescale and a
    // float. Refusing it would delete real footage to catch nobody.
    expect(judgeVideoDuration(60.4, 60)).toBe("withinCap");
  });

  it("refuses the ten-minute file that claimed to be eight seconds", () => {
    expect(judgeVideoDuration(600, 60)).toBe("overCap");
  });

  it("keeps 'could not tell' separate from 'fine'", () => {
    expect(judgeVideoDuration(undefined, 60)).toBe("unverifiable");
    expect(judgeVideoDuration(Number.NaN, 60)).toBe("unverifiable");
  });
});
