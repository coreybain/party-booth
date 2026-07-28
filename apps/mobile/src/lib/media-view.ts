/**
 * Turning media rows and in-flight captures into one list a guest can read.
 *
 * The native twin of `apps/web/src/lib/media-view.ts`, and deliberately the same
 * shape: the same status vocabulary, the same merge rule, the same precedence.
 * A guest who takes a photo in the app and then opens the party in mobile web
 * must not be told two different stories about it, and the only way to guarantee
 * that is for both surfaces to derive their copy from one set of rules.
 *
 * It is a *twin* rather than a shared module because the two ends hold different
 * local objects — the web queue has `previewUrl`/`retryable`, the native queue
 * has `previewUri` and a `failure` record — and hoisting a lowest common
 * denominator into `@partybooth/contracts` would put React-shaped view state in
 * the package that both the server and the client parse against. What *is*
 * shared is everything that decides anything: `CaptureState`, `MediaState`,
 * `isTerminalCapture` and `MEDIA_LIMITS` all come from
 * `@partybooth/contracts/media`.
 *
 * No React Native imports, so it is unit-tested in plain Node alongside the rest
 * of `src/lib`.
 */

import { isTerminalCapture } from "@partybooth/contracts/media";

import type { MediaItem } from "./api";
import type { CaptureState, MediaState } from "@partybooth/contracts/media";
import type { QueueItem } from "../upload/types";

/** Which colour token a screen should paint the chip. Mapped in `../theme`. */
export type MediaTone = "neutral" | "positive" | "warning" | "danger" | "progress";

export interface StatusCopy {
  readonly label: string;
  readonly tone: MediaTone;
  /** One line under the chip. Empty means "say nothing". */
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/* What a state means to the person who took the photo                        */
/* -------------------------------------------------------------------------- */

/**
 * Guest-facing copy, word for word the same as the web guest's.
 *
 * `declined` is the one that matters: the guest is told their photo was not
 * added and **not** told why or to try again. The host's reason is the host's,
 * and a moderation decision relayed with an explanation starts an argument at a
 * party. `deleted` never reaches a list — `canSeeMedia` excludes it for
 * everybody, its own submitter included — and is here only so the record is
 * total.
 */
export const MEDIA_STATE_COPY: Readonly<Record<MediaState, StatusCopy>> = {
  processing: { label: "Sending", tone: "progress", detail: "Still uploading." },
  pending: { label: "Waiting", tone: "warning", detail: "The host has not reviewed it yet." },
  approved: { label: "Added", tone: "positive", detail: "It is in the gallery." },
  declined: { label: "Not added", tone: "neutral", detail: "The host did not add this one." },
  deleted: { label: "Withdrawn", tone: "neutral", detail: "You took this one back." },
};

/** In-flight states, which only the guest who is uploading ever sees. */
export const CAPTURE_STATE_COPY: Readonly<Record<CaptureState, StatusCopy>> = {
  captured: { label: "Ready", tone: "neutral", detail: "Not sent yet." },
  queued: { label: "Starting", tone: "progress", detail: "Waiting for its turn." },
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
 * Exactly one of `item` and `media` drives the chip — {@link MediaTimelineEntry.status}
 * says which — but both may be present, because a `processing` server row and a
 * local capture with a thumbnail describe the same photograph.
 */
export interface MediaTimelineEntry {
  readonly captureId: string;
  readonly media: MediaItem | undefined;
  readonly item: QueueItem | undefined;
  readonly status: StatusCopy;
  /** Best available image, local file first — it needs no network at all. */
  readonly thumbnailUri: string | undefined;
  /** 0–1 while bytes are moving, otherwise `undefined`. */
  readonly progress: number | undefined;
  readonly createdAt: number;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly canWithdraw: boolean;
  /** A failure sentence to show verbatim, if there is one. */
  readonly message: string | undefined;
}

/**
 * Merge the reactive server list with the local upload queue.
 *
 * The precedence rule, in one sentence: **the local capture wins while it is
 * still the guest's to act on.** Concretely —
 *
 * - `captured`, `queued`, `uploading`, `failed`: local wins. Only the local row
 *   knows the progress, still holds the bytes for a retry, and can be
 *   cancelled; the server row (if any) just says `processing`, which is both
 *   less true and less useful.
 * - `uploaded`, `cancelled`: the server wins where there is a server row. Once
 *   the bytes have landed, the moderation state is the only interesting fact
 *   and it exists only on the server.
 * - A cancelled capture with no server row disappears entirely. Nothing was
 *   stored and nothing is pending; a tombstone with a button on it is clutter.
 *
 * Newest first, taking the local timestamp where there is one so a photo does
 * not jump position the instant its server row arrives.
 */
export function mergeMediaTimeline(
  media: readonly MediaItem[],
  items: readonly QueueItem[],
): MediaTimelineEntry[] {
  const byCapture = new Map<string, MediaItem>();
  for (const row of media) byCapture.set(row.captureId, row);

  const entries: MediaTimelineEntry[] = [];
  const claimed = new Set<string>();

  for (const item of items) {
    const row = byCapture.get(item.captureId);
    const localWins = !isTerminalCapture(item.state);

    if (!localWins && row === undefined && item.state === "cancelled") continue;

    claimed.add(item.captureId);
    entries.push(entryFor({ item, media: row, localWins: localWins || row === undefined }));
  }

  for (const row of media) {
    if (claimed.has(row.captureId)) continue;
    entries.push(entryFor({ item: undefined, media: row, localWins: false }));
  }

  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

function entryFor(input: {
  item: QueueItem | undefined;
  media: MediaItem | undefined;
  localWins: boolean;
}): MediaTimelineEntry {
  const { item, media } = input;
  const useLocal = input.localWins && item !== undefined;

  const status = useLocal
    ? CAPTURE_STATE_COPY[item.state]
    : media !== undefined
      ? MEDIA_STATE_COPY[media.state]
      : item !== undefined
        ? CAPTURE_STATE_COPY[item.state]
        : MEDIA_STATE_COPY.processing;

  return {
    captureId: item?.captureId ?? media?.captureId ?? "",
    media,
    item,
    status,
    // The local thumbnail is a file on this phone; a signed URL is a round trip
    // to Portland that expires. Local first, always.
    thumbnailUri: item?.previewUri ?? media?.previewUrl ?? media?.url,
    progress: useLocal && item.state === "uploading" ? item.progress : undefined,
    createdAt: item?.capturedAt ?? media?.createdAt ?? 0,
    // A permanent refusal (the party is paused, the file is too big) is not
    // fixed by pressing the button again, so the button is not offered.
    canRetry: useLocal && item.state === "failed" && item.failure?.permanent !== true,
    canCancel: useLocal && (item.state === "queued" || item.state === "uploading"),
    // Withdrawal is a server action on a server record, so it needs one.
    // `deleted` is already gone from every list, so it never shows the button.
    canWithdraw: media !== undefined && media.isOwn && media.state !== "deleted",
    message: useLocal ? item.failure?.message : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported rather than reimplemented.
 *
 * This app had its own copy, identical except that it stopped at megabytes — so
 * a party's total storage rendered as "4096 MB" here and "4.0 GB" on the web
 * console, from the same number. Exactly the drift a shared formatter prevents.
 */
export { formatBytes } from "@partybooth/contracts/copy";

/**
 * Is this signed URL still worth putting in an `<Image>`?
 *
 * Read paths return `urlExpiresAt` because a Convex query re-runs when its
 * *data* changes, not when the clock moves — a gallery left open on a phone in
 * somebody's pocket for twelve minutes is holding URLs that expired two minutes
 * ago (ADR 0004 §5). Drawing a placeholder beats drawing a broken image.
 */
export function isUrlUsable(expiresAt: number | undefined, now: number): boolean {
  if (expiresAt === undefined) return true;
  return now < expiresAt;
}

/**
 * The best still-valid URI for one media row, at a given instant.
 *
 * Preview before original (it is smaller and the gallery is a grid of squares),
 * and each is dropped the moment its own signature has expired rather than the
 * pair being treated as one.
 */
export function usableMediaUri(media: MediaItem, now: number): string | undefined {
  if (media.previewUrl !== undefined && isUrlUsable(media.previewUrlExpiresAt, now)) {
    return media.previewUrl;
  }
  if (media.url !== undefined && isUrlUsable(media.urlExpiresAt, now)) return media.url;
  return undefined;
}
