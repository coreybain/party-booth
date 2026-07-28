import { describe, expect, it } from "vitest";

import { MEDIA_STATES } from "@/lib/contracts";
import type { MediaItem } from "@/lib/convex-api";
import type { UploadItem } from "@/lib/upload/machine";

import {
  CAPTURE_STATE_COPY,
  formatBytes,
  formatProgress,
  isUrlUsable,
  MEDIA_STATE_COPY,
  mergeMediaTimeline,
  MODERATION_STATE_COPY,
} from "./media-view";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function mediaRow(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "jm7abc",
    eventId: "je7abc",
    captureId: "wcapture1",
    state: "pending",
    mediaType: "photo",
    fromLibrary: false,
    byteSize: 812_345,
    mimeType: "image/jpeg",
    uploaderUserId: "ju7abc",
    uploaderDisplayName: "Sam",
    isOwn: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function uploadItem(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    captureId: "wcapture1",
    state: "uploading",
    mediaType: "photo",
    mediaSource: "capture",
    file: new File([new Uint8Array(2)], "photo.jpg", { type: "image/jpeg" }),
    byteSize: 812_345,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    metadataStripped: true,
    derivatives: [],
    progress: 0.5,
    retryable: false,
    createdAt: 1_700_000_000_000,
    attempts: 0,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

describe("status copy", () => {
  it("covers every media state, from both sides of the room", () => {
    for (const state of MEDIA_STATES) {
      expect(MEDIA_STATE_COPY[state].label.length).toBeGreaterThan(0);
      expect(MODERATION_STATE_COPY[state].label.length).toBeGreaterThan(0);
    }
  });

  it("never explains a decline to the guest", () => {
    // The host's reason is the host's. Relaying it starts an argument at a party.
    expect(MEDIA_STATE_COPY.declined.detail).not.toMatch(/why|reason|because/i);
    expect(MEDIA_STATE_COPY.declined.tone).not.toBe("danger");
  });
});

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

describe("mergeMediaTimeline", () => {
  it("shows one row when a photo exists both locally and on the server", () => {
    // The seconds after the route handler confirms the grant: a `processing`
    // server row and an `uploading` local item describe one photograph.
    const entries = mergeMediaTimeline([mediaRow({ state: "processing" })], [uploadItem()]);
    expect(entries).toHaveLength(1);
  });

  it("lets the local item win while it is still the guest's to act on", () => {
    const entries = mergeMediaTimeline([mediaRow({ state: "processing" })], [uploadItem()]);
    expect(entries[0]?.status).toEqual(CAPTURE_STATE_COPY.uploading);
    expect(entries[0]?.progress).toBe(0.5);
    expect(entries[0]?.canCancel).toBe(true);
  });

  it("hands over to the server once the bytes have landed", () => {
    const entries = mergeMediaTimeline(
      [mediaRow({ state: "pending" })],
      [uploadItem({ state: "uploaded", progress: 1 })],
    );
    expect(entries[0]?.status).toEqual(MEDIA_STATE_COPY.pending);
    expect(entries[0]?.progress).toBeUndefined();
    expect(entries[0]?.canWithdraw).toBe(true);
  });

  it("offers a retry only for a retryable failure", () => {
    const retryable = mergeMediaTimeline(
      [],
      [uploadItem({ state: "failed", retryable: true, message: "You look offline." })],
    );
    expect(retryable[0]?.canRetry).toBe(true);
    expect(retryable[0]?.message).toBe("You look offline.");

    const refused = mergeMediaTimeline(
      [],
      [uploadItem({ state: "failed", retryable: false, message: "This party is paused." })],
    );
    // A photo refused because the host paused the party cannot be retried into
    // succeeding, and a button that cannot work is worse than no button.
    expect(refused[0]?.canRetry).toBe(false);
  });

  it("drops a cancelled upload that never reached the server", () => {
    expect(mergeMediaTimeline([], [uploadItem({ state: "cancelled" })])).toHaveLength(0);
  });

  it("keeps a cancelled upload that did reach the server", () => {
    // The bytes made it before the abort did; the server row is the truth.
    const entries = mergeMediaTimeline(
      [mediaRow({ state: "pending" })],
      [uploadItem({ state: "cancelled" })],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toEqual(MEDIA_STATE_COPY.pending);
  });

  it("includes server rows with no local counterpart", () => {
    // Everything uploaded before this page was opened.
    const entries = mergeMediaTimeline([mediaRow({ captureId: "wearlier" })], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.upload).toBeUndefined();
  });

  it("orders newest first, using the local timestamp when there is one", () => {
    const entries = mergeMediaTimeline(
      [
        mediaRow({ id: "old", captureId: "wold", createdAt: 1 }),
        mediaRow({ id: "new", captureId: "wnew", createdAt: 3 }),
      ],
      [uploadItem({ captureId: "wmiddle", createdAt: 2 })],
    );
    expect(entries.map((entry) => entry.captureId)).toEqual(["wnew", "wmiddle", "wold"]);
  });

  it("prefers the local thumbnail over a signed URL", () => {
    // An object URL is already decoded; a signed URL is a round trip to Portland.
    const entries = mergeMediaTimeline(
      [mediaRow({ state: "processing", previewUrl: "https://ufs/signed" })],
      [uploadItem({ previewUrl: "blob:local" })],
    );
    expect(entries[0]?.thumbnailUrl).toBe("blob:local");
  });

  it("falls back to the signed preview, then the full signed URL", () => {
    expect(
      mergeMediaTimeline([mediaRow({ previewUrl: "https://ufs/p", url: "https://ufs/u" })], [])[0]
        ?.thumbnailUrl,
    ).toBe("https://ufs/p");
    expect(mergeMediaTimeline([mediaRow({ url: "https://ufs/u" })], [])[0]?.thumbnailUrl).toBe(
      "https://ufs/u",
    );
  });

  it("never offers withdraw for somebody else's item", () => {
    const entries = mergeMediaTimeline([mediaRow({ isOwn: false, state: "approved" })], []);
    expect(entries[0]?.canWithdraw).toBe(false);
  });

  it("returns nothing at all for two empty inputs", () => {
    expect(mergeMediaTimeline([], [])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

describe("formatBytes", () => {
  it("uses KB below a megabyte and MB above", () => {
    expect(formatBytes(812_345)).toBe("793 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });

  it("switches to GB for a whole party's worth", () => {
    // No single file can reach this — a video is capped at 250 MB — but the
    // organiser home adds a party up, and "4096 MB" is a number nobody parses.
    expect(formatBytes(4 * 1024 * 1024 * 1024)).toBe("4.0 GB");
    expect(formatBytes(1023 * 1024 * 1024)).toBe("1023 MB");
  });

  it("never says 0 KB for a real file, and does for nonsense", () => {
    expect(formatBytes(1)).toBe("1 KB");
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(Number.NaN)).toBe("0 KB");
  });
});

describe("formatProgress", () => {
  it("clamps and rounds to whole percent", () => {
    expect(formatProgress(0)).toBe("0%");
    expect(formatProgress(0.456)).toBe("46%");
    expect(formatProgress(2)).toBe("100%");
    expect(formatProgress(Number.NaN)).toBe("0%");
  });
});

describe("isUrlUsable", () => {
  it("treats an absent expiry as usable", () => {
    expect(isUrlUsable(undefined, 1_700_000_000_000)).toBe(true);
  });

  it("expires exactly when it says it does", () => {
    expect(isUrlUsable(1_700_000_000_000, 1_699_999_999_999)).toBe(true);
    expect(isUrlUsable(1_700_000_000_000, 1_700_000_000_000)).toBe(false);
  });
});
