import { cn } from "@/lib/cn";
import type { MediaTone } from "@/lib/media-view";

const TONES: Record<MediaTone, string> = {
  neutral: "border-line bg-raised text-muted",
  positive: "border-positive/35 bg-positive/10 text-positive",
  warning: "border-warning/35 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
  progress: "border-accent/40 bg-accent/10 text-accent",
};

export interface StatusChipProps {
  readonly label: string;
  readonly tone?: MediaTone;
  readonly className?: string;
}

/**
 * The one status pill, used by "My media" and the organiser's media list.
 *
 * Colour is never the only signal: the label spells the state out, because a
 * host moderating on a phone in a dark room with the brightness down cannot tell
 * amber from green, and `prefers-contrast` does not help with that.
 */
export function StatusChip({ label, tone = "neutral", className }: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5",
        "text-xs font-medium leading-5",
        TONES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
