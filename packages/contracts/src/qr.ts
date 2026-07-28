/**
 * A QR encoder, in about four hundred lines.
 *
 * The organiser has to be able to hold their laptop up and have a guest scan
 * it, and the same code goes on printed signage (TODO.md Sprint 7). PLAN.md
 * wants the QR generated **client-side** from the join URL, so nothing about
 * the invite token has to make a second trip to a server, and no third-party
 * image endpoint ever sees a bearer credential.
 *
 * It lives in contracts rather than in an app because the same symbol has to
 * come out of both front doors: the organiser console renders it as inline SVG
 * today, and the app's host tab (TODO.md Sprint 5) renders the same matrix
 * through `react-native-svg`. Two encoders would be two chances to print a code
 * that scans on a laptop and not on a phone. Nothing here touches the DOM,
 * React or a Node built-in — it takes a string and returns a boolean grid, so
 * the *rendering* stays each app's business and the *bits* have one definition.
 *
 * Why not a library: every QR package on npm is either an image encoder (canvas
 * + PNG, which we do not want — we render SVG) or drags in a byte-polyfill
 * chain. The repo already hand-rolls its icon set for the same reason. This is
 * the one algorithm in the repo where "we wrote it ourselves" needs justifying,
 * so the scope is deliberately narrow:
 *
 * - **Byte mode only.** A URL is bytes. Alphanumeric mode would be denser, but
 *   it only accepts upper case and would silently mangle a mixed-case origin.
 * - **Error-correction level M** (~15 % recovery). L is too fragile for a
 *   printed sign in a dim hallway; Q and H cost modules we would rather spend
 *   on quiet zone at small sizes.
 * - **Versions 1–10**, i.e. up to 213 bytes. A join URL is around 70. Anything
 *   longer throws rather than silently producing an unreadable code.
 *
 * Everything is pure and synchronous, so `qr.test.ts` can check it offline.
 * References: ISO/IEC 18004 §6–§8; the tables below are that standard's.
 */

/* -------------------------------------------------------------------------- */
/* Public shape                                                               */
/* -------------------------------------------------------------------------- */

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. `17 + 4 × version`. */
  readonly size: number;
  readonly version: number;
  /** Row-major, `size × size`. `true` is a dark module. */
  readonly modules: readonly boolean[];
}

export class QrCapacityError extends Error {
  override readonly name = "QrCapacityError";
  constructor(byteLength: number) {
    super(
      `Cannot encode ${String(byteLength)} bytes: this encoder supports QR versions 1–10 at error-correction level M, which top out at ${String(MAX_BYTES)} bytes.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tables (ISO/IEC 18004, error-correction level M)                           */
/* -------------------------------------------------------------------------- */

const MIN_VERSION = 1;
const MAX_VERSION = 10;

interface VersionSpec {
  /** EC codewords per block. */
  readonly ecPerBlock: number;
  /** `[blockCount, dataCodewordsPerBlock]` for each of the one or two groups. */
  readonly groups: readonly (readonly [blocks: number, dataCodewords: number])[];
  /** Centre coordinates of the alignment patterns. Empty for version 1. */
  readonly alignment: readonly number[];
}

const VERSIONS: Readonly<Record<number, VersionSpec>> = {
  1: { ecPerBlock: 10, groups: [[1, 16]], alignment: [] },
  2: { ecPerBlock: 16, groups: [[1, 28]], alignment: [6, 18] },
  3: { ecPerBlock: 26, groups: [[1, 44]], alignment: [6, 22] },
  4: { ecPerBlock: 18, groups: [[2, 32]], alignment: [6, 26] },
  5: { ecPerBlock: 24, groups: [[2, 43]], alignment: [6, 30] },
  6: { ecPerBlock: 16, groups: [[4, 27]], alignment: [6, 34] },
  7: { ecPerBlock: 18, groups: [[4, 31]], alignment: [6, 22, 38] },
  8: {
    ecPerBlock: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
    alignment: [6, 24, 42],
  },
  9: {
    ecPerBlock: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
    alignment: [6, 26, 46],
  },
  10: {
    ecPerBlock: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
    alignment: [6, 28, 50],
  },
};

function specFor(version: number): VersionSpec {
  const spec = VERSIONS[version];
  if (!spec) throw new RangeError(`Unsupported QR version ${String(version)}`);
  return spec;
}

function dataCodewords(version: number): number {
  return specFor(version).groups.reduce((total, [blocks, size]) => total + blocks * size, 0);
}

/** Bits in the character-count field. Byte mode: 8 up to version 9, then 16. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** How many UTF-8 bytes fit at this version. */
export function byteCapacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

const MAX_BYTES = byteCapacity(MAX_VERSION);

/* -------------------------------------------------------------------------- */
/* GF(256) arithmetic for Reed–Solomon                                        */
/* -------------------------------------------------------------------------- */

/**
 * Log/antilog tables over GF(2^8) with the QR primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D) and generator α = 2.
 */
const { exp: GF_EXP, log: GF_LOG } = (() => {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255] ?? 0;
  return { exp, log };
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[((GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)) % 255] ?? 0;
}

/** The Reed–Solomon generator polynomial of the given degree, high term first. */
function generatorPolynomial(degree: number): Uint8Array {
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      const coefficient = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(coefficient, GF_EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data · x^degree` divided by the generator: the EC codewords. */
function errorCorrection(data: Uint8Array, degree: number): Uint8Array {
  const generator = generatorPolynomial(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

/* -------------------------------------------------------------------------- */
/* Bit stream                                                                 */
/* -------------------------------------------------------------------------- */

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pad to the codeword count and emit bytes. */
  toCodewords(totalCodewords: number): Uint8Array {
    const capacity = totalCodewords * 8;
    // Terminator: up to four zero bits, then zero-fill to a byte boundary.
    const terminator = Math.min(4, capacity - this.bits.length);
    for (let i = 0; i < terminator; i += 1) this.bits.push(0);
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const codewords = new Uint8Array(totalCodewords);
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      codewords[i / 8] = byte;
    }
    // Alternating pad bytes, per §7.4.10.
    for (let i = this.bits.length / 8, pad = 0; i < totalCodewords; i += 1, pad += 1) {
      codewords[i] = pad % 2 === 0 ? 0xec : 0x11;
    }
    return codewords;
  }
}

/**
 * Split the data codewords into blocks, append each block's EC codewords, and
 * interleave both halves the way §7.6 requires.
 */
function buildCodewords(version: number, data: Uint8Array): Uint8Array {
  const spec = specFor(version);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (const [blockCount, blockSize] of spec.groups) {
    for (let i = 0; i < blockCount; i += 1) {
      const block = data.subarray(offset, offset + blockSize);
      offset += blockSize;
      dataBlocks.push(block);
      ecBlocks.push(errorCorrection(block, spec.ecPerBlock));
    }
  }

  const out: number[] = [];
  const longestData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) {
      const byte = block[i];
      if (byte !== undefined) out.push(byte);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i] ?? 0);
  }
  return Uint8Array.from(out);
}

/* -------------------------------------------------------------------------- */
/* Matrix                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A square grid of modules plus the "this is structure, not data" mask that
 * placement and masking both need.
 */
class Grid {
  readonly size: number;
  private readonly dark: Uint8Array;
  private readonly reserved: Uint8Array;

  constructor(version: number) {
    this.size = 17 + 4 * version;
    this.dark = new Uint8Array(this.size * this.size);
    this.reserved = new Uint8Array(this.size * this.size);
  }

  private index(x: number, y: number): number {
    return y * this.size + x;
  }

  get(x: number, y: number): boolean {
    return (this.dark[this.index(x, y)] ?? 0) === 1;
  }

  set(x: number, y: number, dark: boolean, reserve = true): void {
    const i = this.index(x, y);
    this.dark[i] = dark ? 1 : 0;
    if (reserve) this.reserved[i] = 1;
  }

  isReserved(x: number, y: number): boolean {
    return (this.reserved[this.index(x, y)] ?? 0) === 1;
  }

  reserve(x: number, y: number): void {
    this.reserved[this.index(x, y)] = 1;
  }

  toModules(): boolean[] {
    return Array.from(this.dark, (value) => value === 1);
  }
}

function drawFinder(grid: Grid, left: number, top: number): void {
  // The 7×7 finder plus its one-module separator, clipped to the grid.
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || x >= grid.size || y < 0 || y >= grid.size) continue;
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      grid.set(x, y, ring !== 2 && ring <= 3);
    }
  }
}

function drawAlignment(grid: Grid, centreX: number, centreY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      grid.set(centreX + dx, centreY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const last = grid.size - 7;
  drawFinder(grid, 0, 0);
  drawFinder(grid, last, 0);
  drawFinder(grid, 0, last);

  // Timing patterns.
  for (let i = 8; i < grid.size - 8; i += 1) {
    const dark = i % 2 === 0;
    grid.set(i, 6, dark);
    grid.set(6, i, dark);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = specFor(version).alignment;
  for (const y of centres) {
    for (const x of centres) {
      const onFinder =
        (x === centres[0] && y === centres[0]) ||
        (x === centres[0] && y === centres.at(-1)) ||
        (x === centres.at(-1) && y === centres[0]);
      if (!onFinder) drawAlignment(grid, x, y);
    }
  }

  // The always-dark module below the top-left format strip.
  grid.set(8, grid.size - 8, true);

  // Reserve the two format-information strips.
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      grid.reserve(i, 8);
      grid.reserve(8, i);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    grid.reserve(grid.size - 1 - i, 8);
    grid.reserve(8, grid.size - 1 - i);
  }

  // Version information (two 6×3 blocks) exists from version 7.
  if (version >= 7) {
    const bits = versionInformationBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + grid.size - 11;
      grid.set(a, b, dark);
      grid.set(b, a, dark);
    }
  }
}

/** BCH(18,6) with generator 0x1F25, per §7.9.2. */
function versionInformationBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainder) >>> 0;
}

/** BCH(15,5) with generator 0x537, masked with 0x5412, per §7.9.1. */
function formatInformationBits(mask: number): number {
  // Error-correction level M is indicated by 0b00.
  const data = (0b00 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return (((data << 10) | remainder) ^ 0x5412) >>> 0;
}

function drawFormatInformation(grid: Grid, mask: number): void {
  const bits = formatInformationBits(mask);
  // Copy 1: around the top-left finder, least significant bit first.
  for (let i = 0; i < 6; i += 1) grid.set(8, i, bit(bits, i));
  grid.set(8, 7, bit(bits, 6));
  grid.set(8, 8, bit(bits, 7));
  grid.set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) grid.set(14 - i, 8, bit(bits, i));

  // Copy 2: split between the other two finders.
  for (let i = 0; i < 8; i += 1) grid.set(grid.size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) grid.set(8, grid.size - 15 + i, bit(bits, i));
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

/* -------------------------------------------------------------------------- */
/* Masking                                                                    */
/* -------------------------------------------------------------------------- */

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * §7.8.3's four penalty rules. Lower is better; the encoder tries all eight
 * masks and keeps the lowest, which is what stops a URL full of repeating
 * characters producing a code with a scanner-confusing texture.
 */
function penalty(grid: Grid): number {
  const size = grid.size;
  let score = 0;

  // Rule 1 — runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      let previous = horizontal ? grid.get(0, i) : grid.get(i, 0);
      for (let j = 1; j < size; j += 1) {
        const current = horizontal ? grid.get(j, i) : grid.get(i, j);
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          previous = current;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const first = grid.get(x, y);
      if (
        first === grid.get(x + 1, y) &&
        first === grid.get(x, y + 1) &&
        first === grid.get(x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }

  // Rule 3 — the 1:1:3:1:1 finder ratio appearing in the data, with four
  // light modules on either side. This is the one a scanner actually trips on.
  const FINDER = [true, false, true, true, true, false, true];
  const LIGHT_RUN = [false, false, false, false];
  for (let i = 0; i < size; i += 1) {
    for (const horizontal of [true, false]) {
      const line: boolean[] = [];
      for (let j = 0; j < size; j += 1) {
        line.push(horizontal ? grid.get(j, i) : grid.get(i, j));
      }
      for (let j = 0; j + 7 <= size; j += 1) {
        if (!FINDER.every((value, k) => line[j + k] === value)) continue;
        const before = line.slice(Math.max(0, j - 4), j);
        const after = line.slice(j + 7, j + 11);
        const clearBefore = before.length === 4 && LIGHT_RUN.every((v, k) => before[k] === v);
        const clearAfter = after.length === 4 && LIGHT_RUN.every((v, k) => after[k] === v);
        if (clearBefore || clearAfter) score += 40;
      }
    }
  }

  // Rule 4 — deviation from an even split of dark and light.
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (grid.get(x, y)) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Walk the two-module-wide zigzag from the bottom right, skipping function
 * modules and the vertical timing column, writing one codeword bit per free
 * module (§7.7.3).
 */
function placeData(grid: Grid, codewords: Uint8Array, mask: number): void {
  const maskFn = MASKS[mask];
  if (!maskFn) throw new RangeError(`Unknown QR mask ${String(mask)}`);

  let bitIndex = 0;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern. Shifting `right` itself (rather
    // than a local copy) is what keeps the *following* pairs aligned to
    // 3/2 and 1/0 — copying it instead silently leaves column 0 empty.
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < grid.size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const y = upward ? grid.size - 1 - vertical : vertical;
        if (grid.isReserved(x, y)) continue;
        // Past the end of the stream the remainder bits stay light, then get
        // masked like any other module — which is what the spec asks for.
        const byte = codewords[bitIndex >>> 3] ?? 0;
        const dataBit =
          bitIndex < codewords.length * 8 && ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex += 1;
        grid.set(x, y, dataBit !== maskFn(x, y));
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Encoder                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Encode `text` as a QR matrix.
 *
 * @throws {QrCapacityError} when the UTF-8 encoding exceeds version 10 at
 * error-correction level M. Callers show the URL as text instead rather than
 * rendering a code nothing can read.
 */
export function encodeQr(text: string, options: { readonly mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_BYTES) throw new QrCapacityError(bytes.length);

  let version = MIN_VERSION;
  while (bytes.length > byteCapacity(version)) version += 1;

  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, countBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  const codewords = buildCodewords(version, buffer.toCodewords(dataCodewords(version)));

  let best: { grid: Grid; score: number } | undefined;
  const candidates = options.mask === undefined ? MASKS.map((_fn, index) => index) : [options.mask];
  for (const mask of candidates) {
    const grid = new Grid(version);
    drawFunctionPatterns(grid, version);
    placeData(grid, codewords, mask);
    drawFormatInformation(grid, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, score };
  }
  if (!best) throw new Error("QR mask selection produced no candidate");

  return { size: best.grid.size, version, modules: best.grid.toModules() };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four-module light border the standard requires. Without it a scanner
 * cannot find the finder patterns against a dark page — and this app is dark.
 */
export const QR_QUIET_ZONE = 4;

/**
 * The matrix as a single SVG path `d` attribute (one `M…h1v1h-1z` per dark
 * module).
 *
 * One path rather than N rects because a version-5 code is 1,369 modules, and
 * that many DOM nodes is a visible hitch on a mid-range Android phone. The
 * viewBox is `0 0 n n` including the quiet zone, so the caller only has to pick
 * a pixel size.
 */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y * matrix.size + x] !== true) continue;
      parts.push(`M${String(x + QR_QUIET_ZONE)} ${String(y + QR_QUIET_ZONE)}h1v1h-1z`);
    }
  }
  return parts.join("");
}

/** Side of the SVG viewBox: the matrix plus a quiet zone on both sides. */
export function qrViewBoxSize(matrix: QrMatrix): number {
  return matrix.size + QR_QUIET_ZONE * 2;
}
