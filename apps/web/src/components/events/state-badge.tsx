import { cn } from "@/lib/cn";
import { EVENT_STATE_COPY, type StateTone } from "@/lib/event-view";
import type { EventState } from "@/lib/contracts";

const TONES: Record<StateTone, string> = {
  neutral: "border-line bg-raised text-muted",
  positive: "border-positive/40 bg-positive/10 text-positive",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
};

/** The one-word answer to "is this thing on?". */
export function StateBadge({
  state,
  className,
}: {
  readonly state: EventState;
  readonly className?: string;
}) {
  const { label, tone } = EVENT_STATE_COPY[state];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
