import { encodeQr, QR_QUIET_ZONE, qrViewBoxSize } from "@partybooth/contracts/qr";
import { describe, expect, it } from "vitest";

import { qrDarkModuleCount, qrGrid } from "./qr-view";

const JOIN_URL = "https://partybooth.app/join/K7QM4ZR2XW9TB3HD";

describe("qrGrid", () => {
  it("keeps every dark module the encoder produced", () => {
    const matrix = encodeQr(JOIN_URL);
    const expected = matrix.modules.filter((module) => module).length;

    const grid = qrGrid(JOIN_URL);
    expect(grid).not.toBeNull();
    expect(qrDarkModuleCount(grid as NonNullable<typeof grid>)).toBe(expected);
  });

  it("offsets every run by the quiet zone and stays inside the extent", () => {
    const grid = qrGrid(JOIN_URL);
    if (grid === null) throw new Error("expected a grid");

    expect(grid.extent).toBe(qrViewBoxSize(encodeQr(JOIN_URL)));

    for (const row of grid.rows) {
      expect(row.y).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(row.y).toBeLessThan(grid.extent - QR_QUIET_ZONE);
      for (const run of row.runs) {
        expect(run.x).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
        expect(run.length).toBeGreaterThan(0);
        expect(run.x + run.length).toBeLessThanOrEqual(grid.extent - QR_QUIET_ZONE);
      }
    }
  });

  it("draws the top-left finder pattern as one seven-module run", () => {
    const grid = qrGrid(JOIN_URL);
    if (grid === null) throw new Error("expected a grid");

    // Row 0 of any QR symbol is the top edge of the two upper finder patterns:
    // seven dark modules, a gap, then seven more. If the run encoder is off by
    // one anywhere, this is where it shows first.
    const first = grid.rows[0];
    expect(first?.y).toBe(QR_QUIET_ZONE);
    expect(first?.runs[0]).toEqual({ x: QR_QUIET_ZONE, length: 7 });
    expect(first?.runs.at(-1)?.length).toBe(7);
    expect(first?.runs.at(-1)?.x).toBe(grid.extent - QR_QUIET_ZONE - 7);
  });

  it("closes a run that reaches the right-hand edge", () => {
    const grid = qrGrid(JOIN_URL);
    if (grid === null) throw new Error("expected a grid");

    // The rightmost column of the top finder pattern is dark, so at least one
    // row must end flush with the matrix edge. Without the end-of-row flush in
    // `qrGrid`, that run is silently dropped and the symbol stops scanning.
    const flush = grid.rows.some((row) =>
      row.runs.some((run) => run.x + run.length === grid.extent - QR_QUIET_ZONE),
    );
    expect(flush).toBe(true);
  });

  it("returns null rather than throwing when the value cannot be encoded", () => {
    // The encoder tops out at version 10 / level M. Anything longer is a
    // capacity error, and this is called during render.
    expect(qrGrid("x".repeat(5_000))).toBeNull();
  });
});
