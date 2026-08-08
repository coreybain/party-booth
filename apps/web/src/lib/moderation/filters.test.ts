import { describe, expect, it } from "vitest";

import {
  activeModerationFilters,
  countModerationRows,
  DEFAULT_MODERATION_FILTERS,
  describeVisible,
  filterModerationRows,
  isDefaultFilters,
  isFlagged,
  moderationBand,
  sortForModeration,
  submitterOptions,
  visibleModerationRows,
  withoutModerationFilter,
  type ModerationFilters,
  type ModerationRow,
} from "@/lib/moderation/filters";

function row(overrides: Partial<ModerationRow> & Pick<ModerationRow, "id">): ModerationRow {
  return {
    state: "pending",
    mediaType: "photo",
    uploaderUserId: "u1",
    uploaderDisplayName: "Ada",
    createdAt: 1_000,
    ...overrides,
  };
}

const filters = (overrides: Partial<ModerationFilters> = {}): ModerationFilters => ({
  ...DEFAULT_MODERATION_FILTERS,
  ...overrides,
});

describe("filtering", () => {
  it("hides declined by default and shows it when the toggle is on", () => {
    const rows = [row({ id: "a" }), row({ id: "b", state: "declined" })];

    expect(filterModerationRows(rows, filters()).map((item) => item.id)).toEqual(["a"]);
    expect(filterModerationRows(rows, filters({ showDeclined: true })).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("shows declined when the host asks for it by name, toggle or no toggle", () => {
    // Otherwise picking "Declined" from the status list returns an empty grid,
    // which reads as a broken filter rather than as a hidden one.
    const rows = [row({ id: "a" }), row({ id: "b", state: "declined" })];
    const shown = filterModerationRows(rows, filters({ status: "declined" }));
    expect(shown.map((item) => item.id)).toEqual(["b"]);
  });

  it("never shows a withdrawn item, whatever the filters say", () => {
    const rows = [row({ id: "gone", state: "deleted" })];
    expect(filterModerationRows(rows, filters({ status: "all", showDeclined: true }))).toEqual([]);
  });

  it("filters by state, type, submitter and flagged independently", () => {
    const rows = [
      row({ id: "a", state: "approved", mediaType: "video", uploaderUserId: "u2" }),
      row({ id: "b", state: "pending", mediaType: "photo", uploaderUserId: "u1", reportCount: 2 }),
      row({ id: "c", state: "pending", mediaType: "video", uploaderUserId: "u1" }),
    ];

    expect(filterModerationRows(rows, filters({ status: "approved" })).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(filterModerationRows(rows, filters({ mediaType: "video" })).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
    expect(filterModerationRows(rows, filters({ submitter: "u1" })).map((r) => r.id)).toEqual([
      "b",
      "c",
    ]);
    expect(filterModerationRows(rows, filters({ flaggedOnly: true })).map((r) => r.id)).toEqual([
      "b",
    ]);
  });

  it("treats a flaggedAt with no count as flagged", () => {
    expect(isFlagged(row({ id: "a", flaggedAt: 5 }))).toBe(true);
    expect(isFlagged(row({ id: "b", reportCount: 0 }))).toBe(false);
    expect(isFlagged(row({ id: "c" }))).toBe(false);
  });

  it("knows when nothing has been changed", () => {
    expect(isDefaultFilters(filters())).toBe(true);
    expect(isDefaultFilters(filters({ flaggedOnly: true }))).toBe(false);
  });

  it("describes each active filter as a removable chip", () => {
    expect(
      activeModerationFilters(
        filters({
          status: "approved",
          mediaType: "photo",
          submitter: "u1",
          flaggedOnly: true,
          showDeclined: true,
        }),
        [{ value: "u1", label: "Ada", count: 3 }],
      ),
    ).toEqual([
      { key: "status", label: "Status: Approved" },
      { key: "mediaType", label: "Type: Photos" },
      { key: "submitter", label: "Submitter: Ada" },
      { key: "flaggedOnly", label: "Reported only" },
      { key: "showDeclined", label: "Show declined" },
    ]);
  });

  it("removes one filter without clearing the others", () => {
    const current = filters({ status: "approved", mediaType: "video", flaggedOnly: true });
    expect(withoutModerationFilter(current, "status")).toEqual(
      filters({ mediaType: "video", flaggedOnly: true }),
    );
    expect(withoutModerationFilter(current, "flaggedOnly")).toEqual(
      filters({ status: "approved", mediaType: "video" }),
    );
  });
});

describe("ordering", () => {
  it("puts flagged pending first, then pending, then the rest", () => {
    const rows = [
      row({ id: "approved", state: "approved", createdAt: 9_000 }),
      row({ id: "pending", state: "pending", createdAt: 2_000 }),
      row({ id: "declined", state: "declined", createdAt: 8_000 }),
      row({ id: "flagged", state: "pending", createdAt: 1_000, reportCount: 1 }),
      row({ id: "processing", state: "processing", createdAt: 7_000 }),
    ];

    expect(sortForModeration(rows).map((item) => item.id)).toEqual([
      "flagged",
      "pending",
      "processing",
      "approved",
      "declined",
    ]);
  });

  it("puts a flagged item that has already been decided above ordinary history", () => {
    expect(moderationBand(row({ id: "a", state: "approved", reportCount: 3 }))).toBeLessThan(
      moderationBand(row({ id: "b", state: "approved" })),
    );
  });

  it("is newest-first inside a band", () => {
    const rows = [
      row({ id: "old", createdAt: 1_000 }),
      row({ id: "new", createdAt: 3_000 }),
      row({ id: "mid", createdAt: 2_000 }),
    ];
    expect(sortForModeration(rows).map((item) => item.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks a same-millisecond tie deterministically", () => {
    // Fifty phones firing at once is ordinary; a comparator returning 0 lets the
    // grid reshuffle on every subscription tick, under the host's finger.
    const a = row({ id: "aaa", createdAt: 5_000 });
    const b = row({ id: "bbb", createdAt: 5_000 });
    expect(sortForModeration([a, b]).map((item) => item.id)).toEqual(["aaa", "bbb"]);
    expect(sortForModeration([b, a]).map((item) => item.id)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row({ id: "b", createdAt: 1 }), row({ id: "a", createdAt: 2 })];
    sortForModeration(rows);
    expect(rows.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("filters and sorts in one pass", () => {
    const rows = [
      row({ id: "declined", state: "declined", createdAt: 9_000 }),
      row({ id: "pending", state: "pending", createdAt: 1_000 }),
    ];
    expect(visibleModerationRows(rows, filters()).map((item) => item.id)).toEqual(["pending"]);
  });
});

describe("counts and options", () => {
  it("counts every live state and ignores withdrawals", () => {
    const counts = countModerationRows([
      row({ id: "a", state: "pending" }),
      row({ id: "b", state: "pending", reportCount: 1 }),
      row({ id: "c", state: "approved" }),
      row({ id: "d", state: "declined" }),
      row({ id: "e", state: "processing" }),
      row({ id: "f", state: "deleted" }),
    ]);

    expect(counts).toEqual({
      total: 5,
      pending: 2,
      approved: 1,
      declined: 1,
      processing: 1,
      flagged: 1,
    });
  });

  it("lists submitters busiest first", () => {
    const rows = [
      row({ id: "1", uploaderUserId: "u1", uploaderDisplayName: "Ada" }),
      row({ id: "2", uploaderUserId: "u2", uploaderDisplayName: "Bo" }),
      row({ id: "3", uploaderUserId: "u2", uploaderDisplayName: "Bo" }),
      row({ id: "4", uploaderUserId: "u3", uploaderDisplayName: "Cy", state: "deleted" }),
    ];

    expect(submitterOptions(rows)).toEqual([
      { value: "u2", label: "Bo", count: 2 },
      { value: "u1", label: "Ada", count: 1 },
    ]);
  });

  it("describes the visible subset without lying about it", () => {
    expect(describeVisible(0, 0)).toBe("Nothing yet");
    expect(describeVisible(1, 1)).toBe("1 item");
    expect(describeVisible(4, 4)).toBe("4 items");
    expect(describeVisible(3, 41)).toBe("3 of 41 shown");
  });
});
