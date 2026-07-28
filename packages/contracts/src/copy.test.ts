import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDuration,
  formatReportCount,
  REPORT_REASON_LABELS,
  REPORT_REASON_PROMPTS,
  REPORT_STATUS_LABELS,
} from "./copy";
import { REPORT_REASONS, REPORT_STATUSES } from "./media";

describe("report copy", () => {
  it("covers every reason in both registers", () => {
    // The `Record` type already enforces this at compile time; asserting it here
    // is what catches a member added to the enum and given an empty string.
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABELS[reason].length).toBeGreaterThan(0);
      expect(REPORT_REASON_PROMPTS[reason].label.length).toBeGreaterThan(0);
      expect(REPORT_REASON_PROMPTS[reason].detail.length).toBeGreaterThan(0);
    }
  });

  it("covers every status", () => {
    for (const status of REPORT_STATUSES) {
      expect(REPORT_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it("keeps the two registers genuinely distinct where they should be", () => {
    // The guest is telling us something about themselves; the host is reading a
    // category. If these ever collapse into one string the split is pointless.
    expect(REPORT_REASON_PROMPTS.notMyPhoto.label).not.toBe(REPORT_REASON_LABELS.notMyPhoto);
  });

  it("never names a reporter anywhere in the host's copy", () => {
    const joined = Object.values(REPORT_REASON_LABELS).join(" ").toLowerCase();
    expect(joined).not.toContain("reported by");
  });
});

describe("formatReportCount", () => {
  it("agrees with itself about the singular", () => {
    expect(formatReportCount(1)).toBe("1 report");
    expect(formatReportCount(0)).toBe("0 reports");
    expect(formatReportCount(3)).toBe("3 reports");
  });

  it("does not render a fraction into a badge", () => {
    expect(formatReportCount(2.7)).toBe("2 reports");
    expect(formatReportCount(-1)).toBe("0 reports");
  });
});

describe("formatBytes", () => {
  it("uses kilobytes below a megabyte", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(812 * 1024)).toBe("812 KB");
  });

  it("switches to megabytes, with a decimal only while it is worth one", () => {
    expect(formatBytes(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MB");
  });

  it("has a gigabyte tier, so a whole party is a number a host can read", () => {
    // The regression this exists for: `apps/mobile` had no GB tier and rendered
    // a successful party's storage figure as "4096 MB".
    expect(formatBytes(4 * 1024 * 1024 * 1024)).toBe("4.0 GB");
    expect(formatBytes(12 * 1024 * 1024 * 1024)).toBe("12 GB");
  });

  it("never renders a negative or a NaN", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(-1)).toBe("0 KB");
    expect(formatBytes(Number.NaN)).toBe("0 KB");
  });

  it("rounds a sliver up rather than showing 0 KB for a real file", () => {
    expect(formatBytes(1)).toBe("1 KB");
  });
});

describe("formatDuration", () => {
  it("pads the seconds", () => {
    expect(formatDuration(1)).toBe("0:01");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(60)).toBe("1:00");
    expect(formatDuration(64)).toBe("1:04");
  });

  it("rounds rather than truncating", () => {
    expect(formatDuration(9.4)).toBe("0:09");
    expect(formatDuration(9.6)).toBe("0:10");
  });

  it("answers 0:00 for everything it cannot render", () => {
    expect(formatDuration(undefined)).toBe("0:00");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-1)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });
});
