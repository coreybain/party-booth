"use client";

import { forwardRef } from "react";

import { CheckIcon, FlagIcon, XIcon } from "@/components/icons";
import { MediaTile } from "@/components/media/media-tile";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { cn } from "@/lib/cn";
import type { ModerationActionName } from "@/lib/contracts";
import type { MediaItem } from "@/lib/convex-api";
import { formatRelative } from "@/lib/datetime";
import { MODERATION_STATE_COPY } from "@/lib/media-view";
import { isFlagged } from "@/lib/moderation/filters";
import { canAct } from "@/lib/moderation/selection";

/**
 * One card in the moderation grid.
 *
 * Three things about it are deliberate:
 *
 * - **The buttons offered are the ones that would work.** `canAct` runs
 *   `moderationTransition` — the same function the Convex mutation runs — so
 *   "Revoke" appears on approved items and nowhere else, and "Approve" is gone
 *   from something already approved rather than present and idempotent. A host
 *   tapping a button that does nothing at 1 a.m. concludes the app is broken.
 * - **Flagged is loud.** A reported card gets a border, a badge and a count,
 *   because it is the one decision on this screen with a clock on it.
 * - **Selection is a real checkbox**, not a click-anywhere toggle. Clicking the
 *   picture opens the video; clicking the card body moves the keyboard cursor.
 *   Overloading the whole surface with "select" is how a host selects forty
 *   items while trying to look at one.
 */

export interface ModerationCardProps {
  readonly item: MediaItem;
  readonly now: number;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly busy: boolean;
  readonly onToggleSelect: (id: string, extend: boolean) => void;
  readonly onFocus: (id: string) => void;
  readonly onReview: (id: string) => void;
  readonly onAct: (action: ModerationActionName, ids: readonly string[]) => void;
}

export const ModerationCard = forwardRef<HTMLElement, ModerationCardProps>(function ModerationCard(
  { item, now, selected, focused, busy, onToggleSelect, onFocus, onReview, onAct },
  ref,
) {
  const copy = MODERATION_STATE_COPY[item.state];
  const flagged = isFlagged(item);
  const reports = item.reportCount ?? 0;

  return (
    <article
      ref={ref}
      data-media-id={item.id}
      aria-current={focused ? "true" : undefined}
      onClick={() => {
        onFocus(item.id);
      }}
      className={cn(
        "flex break-inside-avoid gap-3 rounded-2xl border bg-surface p-2.5 transition-colors",
        "sm:mb-3 sm:block",
        selected ? "border-accent bg-accent-soft/40" : "border-line",
        flagged && !selected && "border-danger/50",
        focused && "outline outline-2 outline-offset-2 outline-accent",
      )}
    >
      <div className="relative h-28 w-28 shrink-0 sm:h-auto sm:w-auto">
        <button
          type="button"
          aria-label={`Review ${item.mediaType} from ${item.uploaderDisplayName}`}
          className="block h-full w-full rounded-xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:h-auto"
          onClick={(event) => {
            event.stopPropagation();
            onReview(item.id);
          }}
        >
          <MediaTile item={item} playable={false} className="h-full sm:h-auto" />
        </button>

        <label
          className={cn(
            "absolute left-2 top-2 flex h-8 w-8 cursor-pointer items-center justify-center",
            "rounded-lg border border-white/40 bg-black/45 backdrop-blur-sm",
            selected && "border-accent bg-accent text-on-accent",
          )}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <input
            type="checkbox"
            className="sr-only"
            checked={selected}
            aria-label={`Select ${item.mediaType} from ${item.uploaderDisplayName}`}
            onChange={(event) => {
              // Shift-click extends from the anchor, the way every file manager
              // in the world does it.
              onToggleSelect(item.id, (event.nativeEvent as MouseEvent).shiftKey === true);
            }}
          />
          <CheckIcon size={18} className={selected ? "text-on-accent" : "text-white/85"} />
        </label>

        {flagged ? (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-danger px-1.5 py-1 text-[11px] font-semibold text-white">
            <FlagIcon size={13} />
            {reports > 0 ? reports : null}
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5 px-0.5 sm:mt-2">
        <div className="flex items-center gap-2">
          <StatusChip label={copy.label} tone={copy.tone} />
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted"
            title={item.uploaderDisplayName}
          >
            {item.uploaderDisplayName}
          </span>
        </div>
        <p className="text-xs text-faint">
          {formatRelative(item.uploadedAt ?? item.createdAt, now)}
        </p>

        <div className="grid gap-1.5 pt-1 sm:flex sm:flex-wrap">
          {canAct(item, "approve") ? (
            <Button
              size="sm"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onAct("approve", [item.id]);
              }}
            >
              <CheckIcon size={15} />
              Approve
            </Button>
          ) : null}

          {canAct(item, "decline") ? (
            <Button
              variant="secondary"
              size="sm"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onAct("decline", [item.id]);
              }}
            >
              <XIcon size={15} />
              Decline
            </Button>
          ) : null}

          {canAct(item, "revoke") ? (
            <Button
              variant="danger"
              size="sm"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onAct("revoke", [item.id]);
              }}
            >
              Take down
            </Button>
          ) : null}

          {item.state === "processing" ? (
            <span className="text-xs text-faint">Nothing to decide until it lands.</span>
          ) : null}
        </div>
      </div>
    </article>
  );
});
