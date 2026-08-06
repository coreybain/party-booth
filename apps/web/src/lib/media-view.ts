/**
 * Turning media rows and in-flight uploads into one list a guest can read.
 *
 * Pure and free of React, like `event-view.ts`, for the same two reasons: it is
 * unit-testable offline, and every rule it applies comes from
 * `@partybooth/contracts` — so what "pending" *looks* like on the guest's phone
 * and what `canSeeMedia` will actually *allow* cannot drift apart.
 *
 * The interesting piece is {@link mergeMediaTimeline}. A guest's own photo
 * exists in two places at once for a few seconds:
 *
 * - in the **local upload queue**, where it has a thumbnail and a progress bar
 *   and can be cancelled;
 * - in **`media.myMedia`**, where it is a `processing` row the moment the route
 *   handler confirms the grant, and later `pending` or `approved`.
 *
 * Rendering both is a duplicate; rendering only the server row loses the
 * thumbnail and the retry button; rendering only the local one loses the
 * moderation status and everything uploaded before this page was opened. So they
 * are merged on `captureId` — which is the same key Convex uses for idempotency,
 * and is exactly why the client generates it rather than the server.
 */

import type { MediaItem } from "@/lib/convex-api";
import type { CaptureState, MediaState } from "@/lib/contracts";
import type { UploadItem } from "@/lib/upload/machine";
import { isSettled } from "@/lib/upload/machine";

export type MediaTone = "neutral" | "positive" | "warning" | "danger" | "progress";

export interface StatusCopy {
  readonly label: string;
  readonly tone: MediaTone;
  /** One line under the chip, when there is room. Empty means "say nothing". */
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/* What a state means to the person who took the photo                        */
/* -------------------------------------------------------------------------- */

/**
 * Guest-facing copy, which is deliberately not the same as host-facing copy.
 *
 * `declined` is the one that matters. The guest is told their photo was not
 * added, and **not** told to try again or why — the host's reason is the host's,
 * and a moderation decision relayed with an explanation invites an argument at a
 * party. `deleted` never reaches a list (`canSeeMedia` excludes it for
 * everyone), and is here only so the record is total.
 */
export const MEDIA_STATE_COPY: Readonly<Record<MediaState, StatusCopy>> = {
  processing: { label: "Sending", tone: "progress", detail: "Still uploading." },
  pending: { label: "Waiting", tone: "warning", detail: "The host has not reviewed it yet." },
  approved: { label: "Added", tone: "positive", detail: "It is in the gallery." },
  declined: { label: "Not added", tone: "neutral", detail: "The host did not add this one." },
  deleted: { label: "Withdrawn", tone: "neutral", detail: "You took this one back." },
};

/** The same, from the host's side of the room. */
export const MODERATION_STATE_COPY: Readonly<Record<MediaState, StatusCopy>> = {
  processing: { label: "Uploading", tone: "progress", detail: "Not finished arriving." },
  pending: { label: "Pending", tone: "warning", detail: "Waiting for your decision." },
  approved: { label: "Approved", tone: "positive", detail: "Showing in the gallery." },
  declined: { label: "Declined", tone: "danger", detail: "Hidden from everyone but you." },
  deleted: { label: "Withdrawn", tone: "neutral", detail: "The guest took it back." },
};

/** In-flight states, which only the guest who is uploading ever sees. */
export const CAPTURE_STATE_COPY: Readonly<Record<CaptureState, StatusCopy>> = {
  captured: { label: "Starting", tone: "progress", detail: "Preparing to send." },
  queued: { label: "Starting", tone: "progress", detail: "Asking for permission to send." },
  uploading: { label: "Sending", tone: "progress", detail: "" },
  uploaded: { label: "Sent", tone: "positive", detail: "" },
  failed: { label: "Did not send", tone: "danger", detail: "" },
  cancelled: { label: "Cancelled", tone: "neutral", detail: "" },
};

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row in the guest's "My media" list.
 *
 * Exactly one of `upload` and `media` drives the status chip — {@link status}
 * says which — but both may be present, because a `processing` server row and a
 * local item with a thumbnail describe the same photo.
 */
export interface MediaTimelineEntry {
  readonly captureId: string;
  readonly media: MediaItem | undefined;
  readonly upload: UploadItem | undefined;
  readonly status: StatusCopy;
  /** Best available image for this row, local thumbnail first. */
  readonly thumbnailUrl: string | undefined;
  /** 0–1 while something is moving, otherwise `undefined`. */
  readonly progress: number | undefined;
  readonly createdAt: number;
  /** Set only while the guest can still do something about it. */
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly canWithdraw: boolean;
  /** A failure sentence to show verbatim, if there is one. */
  readonly message: string | undefined;
}

/**
 * Merge the reactive server list with the local upload queue.
 *
 * The precedence rule, in one sentence: **the local item wins while it is still
 * the guest's to act on.** Concretely —
 *
 * - `captured`, `queued`, `uploading`, `failed`: local wins. Only the local item
 *   knows the progress, holds the bytes for a retry, and can be cancelled; the
 *   server row (if any) just says `processing`, which is less true and less
 *   useful.
 * - `uploaded`, `cancelled`: the server wins if there is a server row. Once the
 *   bytes have landed, the moderation state is the only interesting fact, and it
 *   only exists on the server.
 * - A cancelled upload with no server row disappears entirely. Nothing was
 *   stored and nothing is pending; leaving a tombstone would be clutter with a
 *   button on it.
 *
 * Ordering is newest-first on `createdAt`, taking the local timestamp when there
 * is one so a photo does not jump around the list the instant its server row
 * arrives.
 */
export function mergeMediaTimeline(
  media: readonly MediaItem[],
  uploads: readonly UploadItem[],
): MediaTimelineEntry[] {
  const byCapture = new Map<string, MediaItem>();
  for (const item of media) byCapture.set(item.captureId, item);

  const entries: MediaTimelineEntry[] = [];
  const claimed = new Set<string>();

  for (const upload of uploads) {
    const row = byCapture.get(upload.captureId);
    const localWins = !isSettled(upload.state);

    if (!localWins && row === undefined && upload.state === "cancelled") continue;

    claimed.add(upload.captureId);
    entries.push(entryFor({ upload, media: row, localWins: localWins || row === undefined }));
  }

  for (const row of media) {
    if (claimed.has(row.captureId)) continue;
    entries.push(entryFor({ upload: undefined, media: row, localWins: false }));
  }

  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

function entryFor(input: {
  upload: UploadItem | undefined;
  media: MediaItem | undefined;
  localWins: boolean;
}): MediaTimelineEntry {
  const { upload, media } = input;
  const useLocal = input.localWins && upload !== undefined;

  const status = useLocal
    ? CAPTURE_STATE_COPY[upload.state]
    : media !== undefined
      ? MEDIA_STATE_COPY[media.state]
      : upload !== undefined
        ? CAPTURE_STATE_COPY[upload.state]
        : MEDIA_STATE_COPY.processing;

  const captureId = upload?.captureId ?? media?.captureId ?? "";

  return {
    captureId,
    media,
    upload,
    status,
    // The local thumbnail is an object URL that is already decoded and needs no
    // network; a signed URL is a round trip to Portland. Local first, always.
    thumbnailUrl: upload?.previewUrl ?? media?.previewUrl ?? media?.url,
    progress: useLocal && upload.state === "uploading" ? upload.progress : undefined,
    createdAt: upload?.createdAt ?? media?.createdAt ?? 0,
    canRetry: useLocal && upload.state === "failed" && upload.retryable,
    canCancel: useLocal && (upload.state === "queued" || upload.state === "uploading"),
    // Withdrawal needs a media row: it is a server action on a server record.
    // `deleted` is already gone from every list, so it never shows the button.
    canWithdraw: media !== undefined && media.isOwn && media.state !== "deleted",
    message: useLocal ? upload.message : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported from the contract, where `apps/mobile` now gets it too.
 *
 * The two apps had the same function with one difference — this one had a
 * gigabyte tier and the app's stopped at megabytes — so a party's storage total
 * read "4.0 GB" on a laptop and "4096 MB" on a phone.
 */
export { formatBytes } from "@partybooth/contracts/copy";

/** "40%" — for `aria-valuetext`, where a screen reader has to say something. */
export function formatProgress(progress: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return `${String(Math.round(clamped * 100))}%`;
}

/**
 * Is this signed URL still worth putting in an `<img>`?
 *
 * Read paths return `urlExpiresAt` because a Convex query re-runs when its
 * *data* changes, not when the clock moves — a gallery left open for twelve
 * minutes is holding URLs that expired two minutes ago (ADR 0004 §5). Rendering
 * a placeholder beats rendering a broken image.
 */
export function isUrlUsable(expiresAt: number | undefined, now: number): boolean {
  if (expiresAt === undefined) return true;
  return now < expiresAt;
}
