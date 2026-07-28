"use client";

import { useCallback, useRef, type ChangeEvent } from "react";

import { MediaThumbnail } from "@/components/media/media-thumbnail";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusChip } from "@/components/ui/status-chip";
import type { MediaSource } from "@/lib/contracts";
import { CAPTURE_STATE_COPY, formatBytes } from "@/lib/media-view";
import type { UploadItem } from "@/lib/upload/machine";
import type { CaptureController } from "@/lib/use-capture-upload";

/**
 * The guest's capture card — the party-critical screen.
 *
 * PLAN.md makes mobile web the **guaranteed** guest path for 5 August, so this
 * is designed for a specific person: standing up, one hand, phone at 20%
 * brightness, in a room too loud to read a paragraph. That shapes every decision
 * here more than any style guide does.
 *
 * - **`<input type="file" capture="environment">`, not `getUserMedia`.** The
 *   platform camera is the one the guest already knows how to use, it handles
 *   permissions, orientation, focus and the flash without us writing any of it,
 *   and it works identically in iOS Safari and Android Chrome. A custom
 *   viewfinder is a Sprint 6 problem to debug on somebody else's phone.
 * - **Two doors, one flow.** "Take a photo" sets `capture`, "Choose a photo"
 *   does not — that attribute is the only difference between the camera and the
 *   photo roll on mobile, and the second button is hidden entirely when the host
 *   has turned library imports off, rather than shown and then refused.
 * - **Explicit send.** The app auto-sends with a 15-second undo; here the guest
 *   presses a button, which is the same protection without a timer that a
 *   backgrounded Safari tab would not run anyway.
 * - **Touch targets are `size="lg"` (48 px) and full width.** Nothing on this
 *   card is a small tap target, including the destructive ones.
 *
 * The `<input>` is visually hidden rather than styled, because a styled
 * `file` input is a per-browser fight and a hidden one driven by a real
 * `<button>` keeps keyboard and screen-reader behaviour intact.
 */

export interface CapturePanelProps {
  readonly controller: CaptureController;
  /** `false` when the event is not live — the host has not opened it, or paused. */
  readonly uploadsOpen: boolean;
  /** Whether the photo-roll button is offered at all. */
  readonly allowLibraryImport: boolean;
  /** Copy explaining why uploads are shut, from `EVENT_STATE_COPY`. */
  readonly closedReason: string;
}

export function CapturePanel({
  controller,
  uploadsOpen,
  allowLibraryImport,
  closedReason,
}: CapturePanelProps) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  const onPicked = useCallback(
    (source: MediaSource) => (change: ChangeEvent<HTMLInputElement>) => {
      const file = change.target.files?.[0];
      // Reset first: picking the *same* file twice fires no `change` event
      // otherwise, which on a phone reads as "the button stopped working".
      change.target.value = "";
      if (file === undefined) return;
      void controller.select(file, source);
    },
    [controller],
  );

  const pending = controller.queue.items.filter((item) => item.state !== "uploaded");

  if (!uploadsOpen) {
    return (
      <Callout tone="info" live="polite">
        {closedReason}
      </Callout>
    );
  }

  return (
    <section aria-labelledby="capture-heading" className="space-y-4">
      <h2 id="capture-heading" className="text-base font-semibold text-ink">
        Add a photo
      </h2>

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPicked("capture")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={libraryInput}
        type="file"
        accept="image/*"
        onChange={onPicked("library")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      <div className="space-y-3">
        <Button
          size="lg"
          fullWidth
          loading={controller.preparing}
          onClick={() => cameraInput.current?.click()}
        >
          Take a photo
        </Button>
        {allowLibraryImport ? (
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            disabled={controller.preparing}
            onClick={() => libraryInput.current?.click()}
          >
            Choose from your photos
          </Button>
        ) : null}
      </div>

      {controller.preparing ? (
        <p className="text-sm text-muted" role="status" aria-live="polite">
          Preparing your photo…
        </p>
      ) : null}

      {controller.selectionError !== undefined ? (
        <Callout tone="danger" live="assertive">
          {controller.selectionError}
        </Callout>
      ) : null}

      <p className="text-xs leading-relaxed text-faint">
        Photos are re-saved on your phone before they are sent, which removes the location and
        camera details your camera stores in them. Only people at this party can see what you add.
      </p>

      {pending.length > 0 ? (
        <ul className="space-y-3">
          {pending.map((item) => (
            <li key={item.captureId}>
              <PendingCapture item={item} controller={controller} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * One photo that has not landed yet.
 *
 * Every state offers exactly the action that state permits, and no others: a
 * `captured` item can be sent or thrown away, an in-flight one can only be
 * cancelled, and a failure offers "Try again" only when trying again could
 * possibly work — a photo refused because the host paused the party is not
 * retryable, and a button that cannot succeed is worse than no button.
 */
function PendingCapture({
  item,
  controller,
}: {
  readonly item: UploadItem;
  readonly controller: CaptureController;
}) {
  const copy = CAPTURE_STATE_COPY[item.state];

  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface/60 p-3">
      <MediaThumbnail url={item.previewUrl} alt="Your photo" className="w-20" />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <StatusChip label={copy.label} tone={copy.tone} />
          <span className="shrink-0 text-xs text-faint">{formatBytes(item.byteSize)}</span>
        </div>

        {item.state === "uploading" ? (
          <ProgressBar value={item.progress} label="Upload progress" />
        ) : null}

        {item.message !== undefined ? (
          <p className="text-sm text-danger" role="status" aria-live="polite">
            {item.message}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {item.state === "captured" ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  void controller.send(item.captureId);
                }}
              >
                Send it
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  controller.discard(item.captureId);
                }}
              >
                Discard
              </Button>
            </>
          ) : null}

          {item.state === "queued" || item.state === "uploading" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                controller.cancel(item.captureId);
              }}
            >
              Cancel
            </Button>
          ) : null}

          {item.state === "failed" ? (
            <>
              {item.retryable ? (
                <Button
                  size="sm"
                  onClick={() => {
                    void controller.send(item.captureId);
                  }}
                >
                  Try again
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  controller.discard(item.captureId);
                }}
              >
                Discard
              </Button>
            </>
          ) : null}

          {item.state === "cancelled" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                controller.discard(item.captureId);
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
