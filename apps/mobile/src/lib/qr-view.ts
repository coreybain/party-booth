/**
 * A QR matrix, flattened into something React Native can draw without SVG.
 *
 * `apps/web` renders the same matrix as one `<path>` — 1,369 `M…h1v1h-1z`
 * segments in a single DOM node, which is the right answer in a browser. There
 * is no equivalent here: `react-native-svg` is a **native** module, so adding it
 * during launch week means a new EAS build for every client that wants to see a
 * QR code, and CONTRIBUTING's "no new tooling unless it removes more work than
 * it adds today" is pointing straight at that.
 *
 * So the matrix is run-length encoded per row and drawn as plain `View`s. A
 * version-5 symbol is 37 rows of typically eight to twelve dark runs, which is
 * roughly 350 views rather than the 700-plus a view-per-module would cost — and
 * it is a static screen, so they are laid out once and never re-measured.
 *
 * Everything here is pure and takes no React Native import, so it is unit-tested
 * in plain Node. The **encoder** is not ours to reimplement: it is
 * `@partybooth/contracts/qr`, the same one the web console and the printed
 * signage go through, so a phone and a poster can never disagree about what a
 * token encodes to.
 */

import { encodeQr, QR_QUIET_ZONE, qrViewBoxSize } from "@partybooth/contracts/qr";

/** A horizontal stretch of dark modules, in matrix units including the quiet zone. */
export interface QrRun {
  readonly x: number;
  readonly length: number;
}

export interface QrRow {
  readonly y: number;
  readonly runs: readonly QrRun[];
}

export interface QrGrid {
  /** Modules per side **including** both quiet zones — the drawing unit count. */
  readonly extent: number;
  /** Only rows that contain at least one dark module. */
  readonly rows: readonly QrRow[];
}

/**
 * Encode `value` and flatten it, or `null` when it will not fit.
 *
 * Capacity is the encoder's only failure mode and only bites for an absurdly
 * long origin, but it is a *thrown* error and this is called during render, so it
 * is turned into a value the caller can degrade on. Losing the QR is survivable —
 * the six-digit code underneath it is a complete second route into the party.
 */
export function qrGrid(value: string): QrGrid | null {
  let matrix;
  try {
    matrix = encodeQr(value);
  } catch {
    return null;
  }

  const rows: QrRow[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    const runs: QrRun[] = [];
    let start: number | null = null;

    for (let x = 0; x < matrix.size; x += 1) {
      const dark = matrix.modules[y * matrix.size + x] === true;
      if (dark && start === null) start = x;
      if (!dark && start !== null) {
        runs.push({ x: start + QR_QUIET_ZONE, length: x - start });
        start = null;
      }
    }
    // A row can end mid-run — the rightmost column is a real module, not a
    // sentinel — and forgetting to close it is how the right-hand finder pattern
    // loses its outer edge and the symbol stops scanning.
    if (start !== null) {
      runs.push({ x: start + QR_QUIET_ZONE, length: matrix.size - start });
    }

    if (runs.length > 0) rows.push({ y: y + QR_QUIET_ZONE, runs });
  }

  return { extent: qrViewBoxSize(matrix), rows };
}

/** Total dark modules in a grid. Used by the tests to prove nothing was dropped. */
export function qrDarkModuleCount(grid: QrGrid): number {
  return grid.rows.reduce(
    (total, row) => total + row.runs.reduce((sum, run) => sum + run.length, 0),
    0,
  );
}
