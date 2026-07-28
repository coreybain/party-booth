import { cn } from "@/lib/cn";
import { formatProgress } from "@/lib/media-view";

export interface ProgressBarProps {
  /** 0–1. Values outside the range are clamped rather than rejected. */
  readonly value: number;
  readonly label: string;
  readonly className?: string;
}

/**
 * The upload progress bar.
 *
 * A real `role="progressbar"` with `aria-valuenow`, not a decorated `<div>`:
 * this is the single most important piece of feedback on the guest path, and it
 * is exactly the piece a screen-reader user gets nothing from if it is
 * decorative. `aria-valuetext` carries the percentage as a spoken string because
 * `aria-valuenow` on its own is announced inconsistently on iOS.
 *
 * `transition-[width]` rather than `transition-all` so a bar that is updating
 * ten times a second does not also animate its colour, which on an older phone
 * is the difference between a smooth bar and a janky one.
 */
export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const percent = formatProgress(clamped);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={percent}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-raised", className)}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
        style={{ width: percent }}
      />
    </div>
  );
}
