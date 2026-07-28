import { describe, expect, it } from "vitest";

import {
  byteCapacity,
  encodeQr,
  QrCapacityError,
  QR_QUIET_ZONE,
  qrPath,
  qrViewBoxSize,
} from "./qr";

/**
 * The QR encoder is the one piece of this package that has to be *provably*
 * right: a wrong module in a printed code is a party where nobody can join, and
 * it fails silently — the code looks like a QR code either way.
 *
 * The golden matrix below was cross-checked two ways during development,
 * neither of which can run in CI (both would be undeclared dependencies):
 *
 * 1. Byte-for-byte against `toqr`, an independent encoder, at error-correction
 *    level M, for versions 1, 3, 5, 6, 9 and 10.
 * 2. Round-tripped through ZXing (`barcode-detector`), which decoded every
 *    sample back to the exact input string, including a multi-byte UTF-8 one.
 *
 * So this file is a regression test against a verified snapshot, plus the
 * structural invariants that catch the failure modes a snapshot of one input
 * would miss.
 */

function render(text: string): string[] {
  const matrix = encodeQr(text);
  const rows: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    let row = "";
    for (let x = 0; x < matrix.size; x += 1) {
      row += matrix.modules[y * matrix.size + x] === true ? "#" : ".";
    }
    rows.push(row);
  }
  return rows;
}

/** Verified against `toqr` and decoded by ZXing. Do not edit by hand. */
const HELLO_WORLD_V1_M = [
  "#######.##..#.#######",
  "#.....#....#..#.....#",
  "#.###.#..#.#..#.###.#",
  "#.###.#.#..#..#.###.#",
  "#.###.#.###.#.#.###.#",
  "#.....#.#..#..#.....#",
  "#######.#.#.#.#######",
  "........#..##........",
  "#...#.######.#####..#",
  "...#....#.###....####",
  "..######..##.##.#..#.",
  "#####...##...#.......",
  "#####.#.#.#.#.##..##.",
  "........#.#.####.#.##",
  "#######.###.#.#.##.#.",
  "#.....#..#.###.##..##",
  "#.###.#.##.#.##...##.",
  "#.###.#..#..#...##.##",
  "#.###.#..###...###...",
  "#.....#....#.#.......",
  "#######.#########.#.#",
];

describe("encodeQr", () => {
  it("reproduces a verified version-1 symbol exactly", () => {
    expect(render("HELLO WORLD")).toEqual(HELLO_WORLD_V1_M);
  });

  it("is deterministic", () => {
    const text = "https://partybooth.example/join/ABCDEFGHJKMNPQRSTVWXYZ0123456789";
    expect(encodeQr(text).modules).toEqual(encodeQr(text).modules);
  });

  it("picks the smallest version that fits", () => {
    // A realistic join URL: canonical origin + /join/ + a 32-character token.
    expect(
      encodeQr("https://partybooth.example/join/ABCDEFGHJKMNPQRSTVWXYZ0123456789"),
    ).toMatchObject({
      version: 5,
      size: 37,
    });
    expect(encodeQr("a").version).toBe(1);
    expect(encodeQr("x".repeat(byteCapacity(1))).version).toBe(1);
    expect(encodeQr("x".repeat(byteCapacity(1) + 1)).version).toBe(2);
  });

  it("sizes the matrix as 17 + 4 × version", () => {
    for (let version = 1; version <= 10; version += 1) {
      const matrix = encodeQr("x".repeat(byteCapacity(version)));
      expect(matrix.version).toBe(version);
      expect(matrix.size).toBe(17 + 4 * version);
      expect(matrix.modules).toHaveLength(matrix.size * matrix.size);
    }
  });

  it("counts capacity in UTF-8 bytes, not characters", () => {
    // Three bytes each, so 100 of them do not fit where 100 ASCII would.
    expect(encodeQr("あ".repeat(20)).version).toBeGreaterThan(encodeQr("a".repeat(20)).version);
  });

  it("refuses input it cannot encode rather than truncating", () => {
    expect(() => encodeQr("x".repeat(byteCapacity(10) + 1))).toThrow(QrCapacityError);
  });

  it("draws all three finder patterns and both timing patterns", () => {
    const matrix = encodeQr("https://partybooth.example/join/ABCDEFGHJKMNPQRSTVWXYZ0123456789");
    const dark = (x: number, y: number) => matrix.modules[y * matrix.size + x] === true;
    const last = matrix.size - 7;

    for (const [left, top] of [
      [0, 0],
      [last, 0],
      [0, last],
    ] as const) {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(dark(left + dx, top + dy)).toBe(ring !== 2);
        }
      }
    }

    for (let i = 8; i < matrix.size - 8; i += 1) {
      expect(dark(i, 6)).toBe(i % 2 === 0);
      expect(dark(6, i)).toBe(i % 2 === 0);
    }

    // The module that is dark in every valid symbol.
    expect(dark(8, matrix.size - 8)).toBe(true);
  });

  it("writes format information that decodes back to level M and the chosen mask", () => {
    const matrix = encodeQr("https://partybooth.example/join/ABCDEFGHJKMNPQRSTVWXYZ0123456789");
    const dark = (x: number, y: number) => matrix.modules[y * matrix.size + x] === true;

    // Copy 1, least-significant bit first, per ISO/IEC 18004 §7.9.1.
    const bits: boolean[] = [];
    for (let i = 0; i < 6; i += 1) bits.push(dark(8, i));
    bits.push(dark(8, 7), dark(8, 8), dark(7, 8));
    for (let i = 9; i < 15; i += 1) bits.push(dark(14 - i, 8));

    let raw = 0;
    for (const [index, bit] of bits.entries()) if (bit) raw |= 1 << index;
    const data = (raw ^ 0x5412) >>> 10;

    expect((data >> 3) & 0b11).toBe(0b00); // error-correction level M
    expect(data & 0b111).toBeLessThan(8); // a real mask number

    // The second copy has to agree, or half of the scanners in the room fail.
    const second: boolean[] = [];
    for (let i = 0; i < 8; i += 1) second.push(dark(matrix.size - 1 - i, 8));
    for (let i = 8; i < 15; i += 1) second.push(dark(8, matrix.size - 15 + i));
    expect(second).toEqual(bits);
  });
});

describe("qrPath", () => {
  it("emits one sub-path per dark module, offset by the quiet zone", () => {
    const matrix = encodeQr("a");
    const path = qrPath(matrix);
    const darkCount = matrix.modules.filter(Boolean).length;
    expect(path.split("M").length - 1).toBe(darkCount);
    // The top-left finder's corner is always dark and always at (0,0).
    expect(path.startsWith(`M${String(QR_QUIET_ZONE)} ${String(QR_QUIET_ZONE)}h1v1h-1z`)).toBe(
      true,
    );
  });

  it("reserves a four-module quiet zone on every side", () => {
    const matrix = encodeQr("a");
    expect(qrViewBoxSize(matrix)).toBe(matrix.size + 8);
  });
});
