"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";

import { playableUrlOf, reviewUrlOf, stillUrlOf } from "@/components/media/media-tile";
import { MediaThumbnail } from "@/components/media/media-thumbnail";
import { MediaViewer, type MediaViewerItem } from "@/components/media/media-viewer";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusChip } from "@/components/ui/status-chip";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi } from "@/lib/convex-api";
import { mergeMediaTimeline, type MediaTimelineEntry } from "@/lib/media-view";
import type { UploadQueue } from "@/lib/upload/machine";

/**
 * "My media" — everything this guest has sent to this party, and what happened
 * to it.
 *
 * Reads `media.myMedia`, which is a live Convex subscription, so a host
 * approving a photo on their laptop flips the chip on the guest's phone with no
 * refresh. The list is merged with the local upload queue on `captureId`
 * (`mergeMediaTimeline`, tested) so a photo does not appear twice in the seconds
 * where it exists both as bytes in flight and as a `processing` row.
 *
 * ## Withdrawal
 *
 * Two taps, and the second one says what it means. `media.withdraw` is
 * **permanent** — ADR 0004 §6: the row goes to `deleted`, which is terminal;
 * every unspent grant for the capture is expired so an upload still in flight
 * cannot complete; and an action deletes the object from storage, which kills
 * every signed URL ever handed out for it, whatever their expiry says. None of
 * that can be undone, and the confirmation says so in those words rather than
 * "Are you sure?".
 *
 * The item disappears from this list the moment it lands, because `canSeeMedia`
 * excludes `deleted` for everybody including its submitter. That is the correct
 * feedback and it needs no toast.
 */

export interface MyMediaProps {
  readonly eventId: string;
  /** The local queue, so in-flight items show progress rather than "Sending". */
  readonly queue: UploadQueue;
  /** Re-send a failed item. Wired to the same controller the capture card uses. */
  readonly onRetry: (captureId: string) => void;
  readonly onCancel: (captureId: string) => void;
}

export function MyMedia({ eventId, queue, onRetry, onCancel }: MyMediaProps) {
  const media = useQuery(backendApi.media.myMedia, { eventId });
  const withdraw = useMutation(backendApi.media.withdraw);

  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const onWithdraw = useCallback(
    async (mediaId: string): Promise<void> => {
      setWorking(mediaId);
      setError(undefined);
      try {
        await withdraw({ mediaId });
        setConfirming(undefined);
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setWorking(undefined);
      }
    },
    [withdraw],
  );

  const entries = mergeMediaTimeline(media ?? [], queue.items);
  const viewerItems = useMemo(
    () => entries.flatMap((entry) => viewerItemForEntry(entry) ?? []),
    [entries],
  );

  if (media === undefined && entries.length === 0) {
    return (
      <section
        id="your-uploads"
        aria-labelledby="my-media-heading"
        className="scroll-mt-28 space-y-3"
      >
        <h2 id="my-media-heading" className="text-base font-semibold text-ink">
          Your uploads
        </h2>
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <section
      id="your-uploads"
      aria-labelledby="my-media-heading"
      className="scroll-mt-28 space-y-3"
    >
      <h2 id="my-media-heading" className="text-base font-semibold text-ink">
        Your uploads
      </h2>

      {error !== undefined ? (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing yet. Anything you add shows up here with what the host has done with it.
        </p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.captureId}>
              <MyMediaRow
                entry={entry}
                confirming={confirming === entry.media?.id}
                working={working === entry.media?.id}
                onRetry={onRetry}
                onCancel={onCancel}
                onAskWithdraw={setConfirming}
                onOpen={() => setSelectedKey(entry.captureId)}
                onWithdraw={(mediaId) => {
                  void onWithdraw(mediaId);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <MediaViewer
        items={viewerItems}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
        onClose={() => setSelectedKey(null)}
      />
    </section>
  );
}

function MyMediaRow({
  entry,
  confirming,
  working,
  onRetry,
  onCancel,
  onAskWithdraw,
  onOpen,
  onWithdraw,
}: {
  readonly entry: MediaTimelineEntry;
  readonly confirming: boolean;
  readonly working: boolean;
  readonly onRetry: (captureId: string) => void;
  readonly onCancel: (captureId: string) => void;
  readonly onAskWithdraw: (mediaId: string | undefined) => void;
  readonly onOpen: () => void;
  readonly onWithdraw: (mediaId: string) => void;
}) {
  const mediaId = entry.media?.id;

  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface/60 p-3">
      <button
        type="button"
        aria-label={`Open your ${entry.media?.mediaType ?? entry.upload?.mediaType ?? "photo"}`}
        onClick={onOpen}
        disabled={entry.thumbnailUrl === undefined}
        className="h-fit shrink-0 rounded-xl transition-transform enabled:active:scale-95 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <MediaThumbnail url={entry.thumbnailUrl} alt="" className="w-20" />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <StatusChip label={entry.status.label} tone={entry.status.tone} />
            {entry.status.detail.length > 0 ? (
              <p className="mt-1 text-xs text-muted">{entry.status.detail}</p>
            ) : null}
          </div>
        </div>

        {entry.progress !== undefined ? (
          <ProgressBar value={entry.progress} label="Upload progress" />
        ) : null}

        {entry.message !== undefined ? (
          <p className="text-sm text-danger" role="status" aria-live="polite">
            {entry.message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {entry.canRetry ? (
            <Button
              size="sm"
              onClick={() => {
                onRetry(entry.captureId);
              }}
            >
              Try again
            </Button>
          ) : null}

          {entry.canCancel ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onCancel(entry.captureId);
              }}
            >
              Cancel
            </Button>
          ) : null}

          {entry.canWithdraw && mediaId !== undefined ? (
            confirming ? (
              <div className="w-full space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
                <p className="text-sm text-ink">
                  Take this photo back? It is deleted for good — the host loses it too, and it
                  cannot be sent again.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    loading={working}
                    onClick={() => {
                      onWithdraw(mediaId);
                    }}
                  >
                    Yes, delete it
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    onClick={() => {
                      onAskWithdraw(undefined);
                    }}
                  >
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onAskWithdraw(mediaId);
                }}
              >
                Take it back
              </Button>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function viewerItemForEntry(entry: MediaTimelineEntry): MediaViewerItem | null {
  const mediaType = entry.media?.mediaType ?? entry.upload?.mediaType;
  if (mediaType === undefined) return null;

  const imageUrl =
    entry.media === undefined
      ? entry.thumbnailUrl
      : mediaType === "photo"
        ? reviewUrlOf(entry.media)
        : stillUrlOf(entry.media);
  const videoUrl =
    entry.media !== undefined && mediaType === "video" ? playableUrlOf(entry.media) : undefined;
  if (imageUrl === undefined && videoUrl === undefined) return null;

  return {
    key: entry.captureId,
    mediaType,
    imageUrl,
    videoUrl,
    title: `Your ${mediaType}`,
    subtitle: entry.status.label,
  };
}
