import { CAPTURE_STATES, MEDIA_STATES } from "@partybooth/contracts/media";
import { describe, expect, it } from "vitest";

import {
  CAPTURE_STATE_COPY,
  formatBytes,
  isUrlUsable,
  MEDIA_STATE_COPY,
  mergeMediaTimeline,
  usableMediaUri,
  usableUploaderAvatarUri,
} from "./media-view";

import type { MediaItem } from "./api";
import type { CaptureState } from "@partybooth/contracts/media";
import type { QueueItem } from "../upload/types";

const NOW = Date.UTC(2026, 7, 5, 21, 0, 0); // party night, 21:00 UTC.

function queued(overrides: Partial<QueueItem> & { captureId: string }): QueueItem {
  return {
    eventId: "event_1",
    state: "queued",
    mediaType: "photo",
    mediaSource: "capture",
    uri: `file:///captures/${overrides.captureId}.jpg`,
    previewUri: `file:///captures/${overrides.captureId}-preview.jpg`,
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    capturedAt: NOW,
    sourceMetadataStripped: true,
    derivatives: [],
    autoSend: true,
    sendAt: NOW,
    undoDelayMs: 15_000,
    attempts: 0,
    nextAttemptAt: NOW,
    progress: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

function row(overrides: Partial<MediaItem> & { id: string; captureId: string }): MediaItem {
  return {
    eventId: "event_1",
    state: "pending",
    mediaType: "photo",
    fromLibrary: false,
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    uploaderUserId: "user_1",
    uploaderDisplayName: "Sam",
    isOwn: true,
    createdAt: NOW,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Copy tables                                                                */
/* -------------------------------------------------------------------------- */

describe("status copy", () => {
  it("covers every media state the contract defines", () => {
    // A missing entry renders an undefined label, which is how a guest ends up
    // staring at a blank chip instead of "Waiting".
    for (const state of MEDIA_STATES) {
      expect(MEDIA_STATE_COPY[state].label.length).toBeGreaterThan(0);
    }
  });

  it("covers every capture state the contract defines", () => {
    for (const state of CAPTURE_STATES) {
      expect(CAPTURE_STATE_COPY[state].label.length).toBeGreaterThan(0);
    }
  });

  it("never tells a guest why the host declined their photo", () => {
    // The host's reason is the host's. A relayed moderation reason starts an
    // argument at a party, so the copy says what happened and stops.
    const copy = MEDIA_STATE_COPY.declined;
    expect(copy.detail).not.toMatch(/because|reason|try again/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

describe("mergeMediaTimeline", () => {
  it("shows one row for a photo that is both in flight and on the server", () => {
    // The seconds between the route handler confirming a grant and the upload
    // finishing are exactly when a photo exists twice.
    const entries = mergeMediaTimeline(
      [row({ id: "media_1", captureId: "m_1", state: "processing" })],
      [queued({ captureId: "m_1", state: "uploading", progress: 0.4 })],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.captureId).toBe("m_1");
  });

  it("lets the local row win while the guest can still act on it", () => {
    const entries = mergeMediaTimeline(
      [row({ id: "media_1", captureId: "m_1", state: "processing" })],
      [queued({ captureId: "m_1", state: "uploading", progress: 0.4 })],
    );

    // Only the local item knows the progress; the server row just says
    // "processing", which is both less true and less useful.
    expect(entries[0]?.status).toEqual(CAPTURE_STATE_COPY.uploading);
    expect(entries[0]?.progress).toBe(0.4);
    expect(entries[0]?.canCancel).toBe(true);
  });

  it("hands over to the server once the bytes have landed", () => {
    const entries = mergeMediaTimeline(
      [row({ id: "media_1", captureId: "m_1", state: "approved" })],
      [queued({ captureId: "m_1", state: "uploaded", mediaId: "media_1" })],
    );

    // After `uploaded` the moderation state is the only interesting fact, and it
    // exists only on the server.
    expect(entries[0]?.status).toEqual(MEDIA_STATE_COPY.approved);
    expect(entries[0]?.progress).toBeUndefined();
    expect(entries[0]?.canWithdraw).toBe(true);
  });

  it("drops a cancelled capture that never reached the server", () => {
    // Nothing was stored and nothing is pending. A tombstone with a button on it
    // is clutter.
    const entries = mergeMediaTimeline([], [queued({ captureId: "m_1", state: "cancelled" })]);
    expect(entries).toEqual([]);
  });

  it("keeps a cancelled capture that does have a server row", () => {
    const entries = mergeMediaTimeline(
      [row({ id: "media_1", captureId: "m_1", state: "pending" })],
      [queued({ captureId: "m_1", state: "cancelled" })],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toEqual(MEDIA_STATE_COPY.pending);
  });

  it("includes server rows uploaded from another device", () => {
    // Everything sent before this phone was installed, or from mobile web.
    const entries = mergeMediaTimeline([row({ id: "media_1", captureId: "w_9" })], []);
    expect(entries.map((entry) => entry.captureId)).toEqual(["w_9"]);
    expect(entries[0]?.item).toBeUndefined();
  });

  it("offers a retry for a retryable failure and not for a permanent one", () => {
    const entries = mergeMediaTimeline(
      [],
      [
        queued({
          captureId: "m_1",
          state: "failed",
          failure: { message: "The network dropped.", permanent: false },
        }),
        queued({
          captureId: "m_2",
          capturedAt: NOW - 1,
          state: "failed",
          failure: { message: "That party is paused.", permanent: true },
        }),
      ],
    );

    const [retryable, permanent] = entries;
    expect(retryable?.canRetry).toBe(true);
    expect(retryable?.message).toBe("The network dropped.");
    // A button that cannot succeed is worse than no button.
    expect(permanent?.canRetry).toBe(false);
  });

  it("never offers to withdraw somebody else's photo", () => {
    const entries = mergeMediaTimeline(
      [row({ id: "media_1", captureId: "w_1", isOwn: false, state: "approved" })],
      [],
    );
    expect(entries[0]?.canWithdraw).toBe(false);
  });

  it("prefers the local thumbnail over a signed URL", () => {
    // A local file needs no network; a signed URL is a round trip to Portland.
    const entries = mergeMediaTimeline(
      [row({ id: "media_1", captureId: "m_1", previewUrl: "https://cdn/preview.jpg" })],
      [queued({ captureId: "m_1", state: "uploading" })],
    );
    expect(entries[0]?.thumbnailUri).toBe("file:///captures/m_1-preview.jpg");
  });

  it("orders newest first, on the local timestamp where there is one", () => {
    // So a photo does not jump position the instant its server row arrives.
    const entries = mergeMediaTimeline(
      [row({ id: "media_2", captureId: "w_2", createdAt: NOW + 5_000 })],
      [queued({ captureId: "m_1", capturedAt: NOW + 10_000, state: "uploading" })],
    );
    expect(entries.map((entry) => entry.captureId)).toEqual(["m_1", "w_2"]);
  });

  it("produces a usable entry for every capture state", () => {
    // Total by construction: a state with no branch would render a blank row.
    for (const state of CAPTURE_STATES as readonly CaptureState[]) {
      const entries = mergeMediaTimeline(
        [row({ id: "media_1", captureId: "m_1" })],
        [queued({ captureId: "m_1", state })],
      );
      expect(entries[0]?.status.label.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Formatting and URL expiry                                                  */
/* -------------------------------------------------------------------------- */

describe("formatBytes", () => {
  it("uses binary units, matching MEDIA_LIMITS", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(-1)).toBe("0 KB");
    expect(formatBytes(512)).toBe("1 KB");
    expect(formatBytes(831_488)).toBe("812 KB");
    expect(formatBytes(2_516_582)).toBe("2.4 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });
});

describe("isUrlUsable", () => {
  it("treats an absent expiry as usable", () => {
    expect(isUrlUsable(undefined, NOW)).toBe(true);
  });

  it("stops trusting a signature the clock has passed", () => {
    // A Convex query re-runs when its data changes, not when the clock moves —
    // a gallery left open in a pocket holds URLs that expired minutes ago.
    expect(isUrlUsable(NOW + 1, NOW)).toBe(true);
    expect(isUrlUsable(NOW, NOW)).toBe(false);
  });
});

describe("usableMediaUri", () => {
  it("prefers the preview, which is smaller than the original", () => {
    const item = row({
      id: "media_1",
      captureId: "m_1",
      url: "https://cdn/original.jpg",
      urlExpiresAt: NOW + 60_000,
      previewUrl: "https://cdn/preview.jpg",
      previewUrlExpiresAt: NOW + 60_000,
    });
    expect(usableMediaUri(item, NOW)).toBe("https://cdn/preview.jpg");
  });

  it("falls back to the original when only the preview signature has expired", () => {
    // The two are signed separately, so they are checked separately.
    const item = row({
      id: "media_1",
      captureId: "m_1",
      url: "https://cdn/original.jpg",
      urlExpiresAt: NOW + 60_000,
      previewUrl: "https://cdn/preview.jpg",
      previewUrlExpiresAt: NOW - 1,
    });
    expect(usableMediaUri(item, NOW)).toBe("https://cdn/original.jpg");
  });

  it("returns nothing rather than a URL that will 403", () => {
    // A placeholder is a far better failure than a broken-image glyph.
    const item = row({
      id: "media_1",
      captureId: "m_1",
      url: "https://cdn/original.jpg",
      urlExpiresAt: NOW - 1,
    });
    expect(usableMediaUri(item, NOW)).toBeUndefined();
  });

  it("returns nothing while an item is still processing", () => {
    expect(usableMediaUri(row({ id: "media_1", captureId: "m_1" }), NOW)).toBeUndefined();
  });
});

describe("usableUploaderAvatarUri", () => {
  it("returns a private uploader avatar only while its signature is live", () => {
    const item = row({
      id: "media_1",
      captureId: "m_1",
      uploaderAvatarUrl: "https://cdn/avatar.jpg",
      uploaderAvatarUrlExpiresAt: NOW + 1,
    });
    expect(usableUploaderAvatarUri(item, NOW)).toBe("https://cdn/avatar.jpg");
    expect(usableUploaderAvatarUri(item, NOW + 1)).toBeUndefined();
  });
});
