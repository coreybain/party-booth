"use client";

import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface EventSwitcherProps {
  readonly className?: string;
}

/**
 * Placeholder for the event switcher.
 *
 * Events do not exist until Sprint 2, so this reserves the slot and its exact
 * dimensions — dropping a real `<select>`/menu in here later must not reflow the
 * header. Rendered as a disabled button so it is skipped by keyboard navigation
 * and announced as unavailable rather than looking broken.
 *
 * TODO(Sprint 2): replace the body with a menu driven by
 * `useQuery(api.events.listForOrganiser)`; keep the outer shape and classes.
 */
export function EventSwitcher({ className }: EventSwitcherProps) {
  return (
    <button
      type="button"
      disabled
      aria-label="Switch event — no events yet"
      className={cn(
        "flex h-10 min-w-0 max-w-[12rem] items-center gap-2 rounded-full border border-dashed",
        "border-line bg-surface/60 px-3 text-sm text-faint",
        "cursor-not-allowed sm:max-w-[16rem]",
        className,
      )}
    >
      <span className="truncate">No event yet</span>
      <ChevronDownIcon size={16} className="shrink-0" />
    </button>
  );
}
