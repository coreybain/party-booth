"use client";

import { useEffect, useRef, useState } from "react";

import { stillUrlOf } from "@/components/media/media-tile";
import type { MediaItem } from "@/lib/convex-api";
import { cn } from "@/lib/cn";
import {
  CROSSFADE_MS,
  MEDIA_LOAD_TIMEOUT_MS,
  VIDEO_LOAD_TIMEOUT_MS,
} from "@/lib/slideshow/machine";

/**
 * One thing on the television.
 *
 * The rules here are all about a machine nobody is standing next to:
 *
 * - **A slide that will not load reports itself.** Photos and videos both get a
 *   load budget; when it runs out the slide calls `onFailed` and the reducer
 *   skips it permanently. Without that, one expired signed URL is a black
 *   rectangle every rotation for the rest of the night.
 * - **The photo timer starts when the photo is *on screen*,** not when the slide
 *   mounts. Otherwise a slow first paint eats most of the five seconds it was
 *   supposed to be visible for, and on a bad connection the show flickers past
 *   images nobody sees.
 * - **Videos play to the end and then say so.** They are not on the photo timer
 *   at all — a 40-second clip cut off at 5 is worse than no video — so `onEnded`
 *   is what advances them. A video that stalls mid-play falls back to the
 *   duration the media row recorded, plus a margin.
 * - **`muted` is set as a property, not just an attribute.** Safari will refuse
 *   `autoplay` on an element whose muted state it learns about a tick late, and
 *   a refused autoplay on a television is a slideshow that stops.
 *
 * The crossfade is two layers of this component with opposite opacities; the
 * fade-in is armed on the frame *after* mount, because a transition from
 * `opacity-0` set in the same commit does not animate.
 */

export interface SlideProps {
  readonly item: MediaItem;
  readonly muted: boolean;
  readonly paused: boolean;
  readonly slideSeconds: number;
  /** Fades in when true, out when false. */
  readonly active: boolean;
  readonly onDone: (id: string) => void;
  readonly onFailed: (id: string) => void;
}

export function Slide({ item, muted, paused, slideSeconds, active, onDone, onFailed }: SlideProps) {
  const [shown, setShown] = useState(false);
  const [ready, setReady] = useState(false);

  // Armed a frame late so the opacity transition has something to animate from.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setShown(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const isVideo = item.mediaType === "video";
  // The original first, then the derivative. The slideshow is run by a host, so
  // `mayServeOriginal` almost always gives them the full-resolution frame; the
  // preview is the fallback for the case where it does not.
  const source = item.url ?? item.previewUrl;
  const poster = stillUrlOf(item);

  /* -- the load budget --------------------------------------------------- */
  useEffect(() => {
    if (ready || !active) return;
    const budget = isVideo ? VIDEO_LOAD_TIMEOUT_MS : MEDIA_LOAD_TIMEOUT_MS;
    const timer = setTimeout(() => {
      onFailed(item.id);
    }, budget);
    return () => {
      clearTimeout(timer);
    };
  }, [ready, active, isVideo, item.id, onFailed]);

  /* -- the photo timer --------------------------------------------------- */
  useEffect(() => {
    if (isVideo || !ready || !active || paused) return;
    const timer = setTimeout(() => {
      onDone(item.id);
    }, slideSeconds * 1_000);
    return () => {
      clearTimeout(timer);
    };
  }, [isVideo, ready, active, paused, slideSeconds, item.id, onDone]);

  /* -- pausing a video --------------------------------------------------- */
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = video.current;
    if (element === null) return;
    element.muted = muted;
    if (!active) return;
    if (paused) element.pause();
    else void element.play().catch(() => undefined);
  }, [muted, paused, active]);

  if (source === undefined) {
    // Nothing playable. Report it rather than showing an empty rectangle: the
    // usual cause is a video with no derivative being viewed by somebody who is
    // not allowed the original, and that is a slide, not a stall.
    return <FailingSlide id={item.id} onFailed={onFailed} />;
  }

  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        "transition-opacity ease-in-out",
        shown && active ? "opacity-100" : "opacity-0",
      )}
      style={{ transitionDuration: `${String(CROSSFADE_MS)}ms` }}
    >
      {isVideo ? (
        <video
          ref={video}
          src={source}
          poster={poster}
          autoPlay
          muted={muted}
          playsInline
          preload="auto"
          className="max-h-full max-w-full object-contain"
          onCanPlay={() => {
            setReady(true);
          }}
          onEnded={() => {
            onDone(item.id);
          }}
          onError={() => {
            onFailed(item.id);
          }}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- signed private URLs must not be proxied or cached by the image optimizer; see `media-thumbnail.tsx`.
        <img
          src={source}
          alt={`Photo from ${item.uploaderDisplayName}`}
          decoding="async"
          referrerPolicy="no-referrer"
          className="max-h-full max-w-full object-contain"
          onLoad={() => {
            setReady(true);
          }}
          onError={() => {
            onFailed(item.id);
          }}
        />
      )}
      {item.challengePrompt === undefined ? null : (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-6 pb-8 pt-20 text-center">
          <p className="mx-auto max-w-3xl text-balance text-xl font-medium text-white drop-shadow sm:text-2xl">
            {item.challengePrompt}
          </p>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/65">
            Photo challenge
          </p>
        </div>
      )}
    </div>
  );
}

/** A slide with nothing to show, reported once on mount. */
function FailingSlide({
  id,
  onFailed,
}: {
  readonly id: string;
  readonly onFailed: (id: string) => void;
}) {
  useEffect(() => {
    onFailed(id);
  }, [id, onFailed]);
  return null;
}
