"use client";

import {
  FullscreenIcon,
  PauseIcon,
  PlayIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPreviousIcon,
  SoundOffIcon,
  SoundOnIcon,
  XIcon,
} from "@/components/icons";
import { cn } from "@/lib/cn";
import { SLIDE_DURATION_OPTIONS, type SlideOrder } from "@/lib/slideshow/machine";

/**
 * The slideshow's controls, which spend most of the night invisible.
 *
 * They fade out after a few seconds of stillness and come back on any movement
 * — this is running on a television, and a permanent toolbar across the bottom
 * of somebody's party photographs is the thing people ask you to turn off.
 * Hiding is `opacity` plus `pointer-events`, never `display: none`: a control
 * that is unmounted cannot be reached by a keyboard, and every one of these has
 * a keyboard shortcut precisely because the machine is across the room.
 *
 * The mute toggle is always present rather than only appearing for videos.
 * Audio at a party is a decision the host makes once, before the first clip
 * comes round, and a button that appears for eight seconds every twenty slides
 * is a button nobody can press in time.
 */

export interface SlideshowControlsProps {
  readonly visible: boolean;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly order: SlideOrder;
  readonly slideSeconds: number;
  readonly position: string;
  readonly wakeLockActive: boolean;
  readonly wakeLockSupported: boolean;
  readonly onTogglePause: () => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onToggleOrder: () => void;
  readonly onToggleMuted: () => void;
  readonly onSlideSeconds: (seconds: number) => void;
  readonly onFullscreen: () => void;
  readonly onExit: () => void;
}

export function SlideshowControls({
  visible,
  paused,
  muted,
  order,
  slideSeconds,
  position,
  wakeLockActive,
  wakeLockSupported,
  onTogglePause,
  onNext,
  onPrevious,
  onToggleOrder,
  onToggleMuted,
  onSlideSeconds,
  onFullscreen,
  onExit,
}: SlideshowControlsProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 p-4",
        "bg-gradient-to-t from-black/70 to-transparent pb-[max(1rem,env(safe-area-inset-bottom))]",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-center gap-1.5 rounded-2xl bg-black/60 px-2 py-2 backdrop-blur",
          visible ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <IconButton label="Previous (←)" onClick={onPrevious}>
          <SkipPreviousIcon size={20} />
        </IconButton>
        <IconButton label={paused ? "Play (space)" : "Pause (space)"} onClick={onTogglePause}>
          {paused ? <PlayIcon size={20} /> : <PauseIcon size={20} />}
        </IconButton>
        <IconButton label="Next (→)" onClick={onNext}>
          <SkipNextIcon size={20} />
        </IconButton>

        <span className="mx-1 h-6 w-px bg-white/20" aria-hidden="true" />

        <IconButton
          label={
            order === "shuffle" ? "Shuffled — switch to in order (S)" : "In order — shuffle (S)"
          }
          pressed={order === "shuffle"}
          onClick={onToggleOrder}
        >
          <ShuffleIcon size={20} />
        </IconButton>
        <IconButton
          label={muted ? "Sound off — turn on (M)" : "Sound on — turn off (M)"}
          pressed={!muted}
          onClick={onToggleMuted}
        >
          {muted ? <SoundOffIcon size={20} /> : <SoundOnIcon size={20} />}
        </IconButton>

        <label className="ml-1 flex items-center gap-1.5 text-xs text-white/80">
          <span className="sr-only sm:not-sr-only">Seconds</span>
          <select
            value={slideSeconds}
            onChange={(event) => {
              onSlideSeconds(Number(event.target.value));
            }}
            className="h-8 rounded-lg border border-white/25 bg-black/50 px-2 text-sm text-white"
          >
            {SLIDE_DURATION_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds}s
              </option>
            ))}
          </select>
        </label>

        <span className="mx-1 h-6 w-px bg-white/20" aria-hidden="true" />

        <IconButton label="Fullscreen (F)" onClick={onFullscreen}>
          <FullscreenIcon size={20} />
        </IconButton>
        <IconButton label="Leave the slideshow" onClick={onExit}>
          <XIcon size={20} />
        </IconButton>
      </div>

      <p className="text-xs text-white/70">
        {position}
        {wakeLockSupported && !wakeLockActive ? " · the screen may still sleep" : ""}
      </p>
    </div>
  );
}

function IconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "grid h-11 w-11 place-items-center rounded-xl text-white transition-colors",
        "hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white",
        pressed === true && "bg-white/20",
      )}
    >
      {children}
    </button>
  );
}
