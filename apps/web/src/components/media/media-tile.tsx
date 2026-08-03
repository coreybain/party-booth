"use client";

import { useState } from "react";

import { PlayIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { MediaItem } from "@/lib/convex-api";
import { formatDuration } from "@/lib/upload/video";

/**
 * One piece of media, shown at its own shape — the tile the masonry grid, the
 * gallery and the recent-submissions strip all render.
 *
 * ## Which URL it uses, and why the order matters
 *
 * A `MediaItem` may carry three signed URLs and the right one depends on what
 * the tile is doing:
 *
 * - **The still** is `posterUrl ?? previewUrl ?? url`. A video's poster first
 *   because that is what a poster *is*; a photo's preview next because it is
 *   the 480 px derivative rather than the 2560 px original, and a grid of two
 *   hundred cards should not fetch two hundred originals; the original last,
 *   because for a fellow guest it is often simply absent (`mayServeOriginal`).
 * - **The playable source** is `url ?? previewUrl`. Only the original is the
 *   whole clip. A viewer who is served no original — a fellow guest looking at
 *   a video, which no browser can re-encode — gets the poster and a note, not a
 *   broken player.
 *
 * ## Click to play, never autoplay
 *
 * Nothing here plays on its own. A moderation grid that starts nine videos when
 * it renders is a moderation grid that saturates a party's uplink and drains the
 * host's battery, and every one of those requests spends a signed URL the viewer
 * may never have looked at. The slideshow is the one surface that autoplays, and
 * it plays exactly one thing at a time (`components/slideshow/`).
 *
 * `muted` and `playsInline` are set on the element regardless: iOS refuses to
 * play inline without them and takes the video fullscreen instead, which in a
 * moderation grid means the host loses their place on every tap. Audio is one
 * tap away in the native controls.
 */

export interface MediaTileProps {
  readonly item: MediaItem;
  readonly alt?: string;
  readonly className?: string;
  /** Square for even grids; `natural` lets the masonry column breathe. */
  readonly shape?: "square" | "natural";
  /** Turns the play affordance off for tiles that are themselves a button. */
  readonly playable?: boolean;
}

export function stillUrlOf(item: MediaItem): string | undefined {
  return item.posterUrl ?? item.previewUrl ?? item.url;
}

export function playableUrlOf(item: MediaItem): string | undefined {
  return item.url ?? item.previewUrl;
}

/** Full-size source for an explicit review action, with derivatives as fallback. */
export function reviewUrlOf(item: MediaItem): string | undefined {
  return item.url ?? item.previewUrl ?? item.posterUrl;
}

export function MediaTile({
  item,
  alt,
  className,
  shape = "natural",
  playable = true,
}: MediaTileProps) {
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);

  const still = stillUrlOf(item);
  const source = playableUrlOf(item);
  const isVideo = item.mediaType === "video";
  const canPlay = playable && isVideo && source !== undefined;
  const label = alt ?? `${isVideo ? "Video" : "Photo"} from ${item.uploaderDisplayName}`;

  // A landscape 4:3 default: it is the shape most phone video lands in, and a
  // tile with no ratio at all makes the whole column jump when the image loads.
  const ratio =
    shape === "square"
      ? "1 / 1"
      : item.width !== undefined && item.height !== undefined && item.height > 0
        ? `${String(item.width)} / ${String(item.height)}`
        : "4 / 3";

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-line bg-raised",
        className,
      )}
      style={{ aspectRatio: ratio }}
    >
      {playing && source !== undefined ? (
        <video
          src={source}
          poster={still}
          controls
          autoPlay
          muted
          playsInline
          preload="metadata"
          className="h-full w-full bg-black object-contain"
          onError={() => {
            setPlaying(false);
            setBroken(true);
          }}
        />
      ) : still !== undefined && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed private URLs must not be proxied or cached by the image optimizer; see `media-thumbnail.tsx`.
        <img
          src={still}
          alt={label}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => {
            // A signed URL that expired mid-subscription. The query re-runs with
            // a fresh one when anything about the row changes.
            setBroken(true);
          }}
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-faint">
          {item.state === "processing" ? "Still arriving…" : "No preview"}
        </span>
      )}

      {isVideo && !playing ? (
        <>
          {canPlay ? (
            <button
              type="button"
              aria-label={`Play ${label}`}
              onClick={() => {
                setPlaying(true);
              }}
              className={cn(
                "absolute inset-0 grid place-items-center bg-black/25 transition-colors",
                "hover:bg-black/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
              )}
            >
              <span className="grid h-12 w-12 place-items-center rounded-full bg-black/60 text-white">
                <PlayIcon size={22} />
              </span>
            </button>
          ) : (
            <span className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-[11px] text-white">
              Video · host view only
            </span>
          )}

          {item.durationSeconds !== undefined ? (
            <span className="absolute right-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white">
              {formatDuration(item.durationSeconds)}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
