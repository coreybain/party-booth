"use client";

import { useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { backendApi, type MediaItem } from "@/lib/convex-api";

/**
 * The slideshow's live feed: every approved item, in arrival order, for ever.
 *
 * `slideshow.feed` is cursored and that is the interesting part. A Convex query
 * re-runs when its *data* changes, so the subscription held here fires every
 * time anybody approves anything — and because the cursor is where the show has
 * got to, the answer to "what changed?" is a page containing **only the new
 * items**. An empty page is the normal case and the whole point: it is what
 * keeps the photograph currently on the television on the television, instead of
 * restarting the show every time a host taps Approve.
 *
 * So the accumulation rule is: advance the cursor only when a page had
 * something in it, and never drop an item once it has been seen. An item that is
 * *un*-approved later (`revoke`) stays in the playlist for the rest of the
 * session — the alternative is a photo vanishing from the middle of a running
 * show, and a host who takes something down mid-party will not be soothed by
 * watching it disappear ten seconds later. The next time the slideshow is opened
 * it is simply not in the feed.
 *
 * `refreshedAt` exists for the one thing a cursor cannot solve: signed URLs
 * expire on a clock, and a subscription that has been idle for twelve minutes is
 * holding URLs that stopped working two minutes ago (ADR 0004 §5). Changing it
 * re-runs the whole feed from the start and re-mints every URL.
 */

export interface SlideshowFeed {
  /** Everything seen so far, in the server's chronological order. */
  readonly items: readonly MediaItem[];
  readonly byId: ReadonlyMap<string, MediaItem>;
  /** Approved items in the event, as the server counts them. */
  readonly total: number;
  readonly loading: boolean;
}

export function useSlideshowFeed(eventId: string, refreshedAt = 0): SlideshowFeed {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<readonly MediaItem[]>([]);

  // A refresh is a fresh start: drop the cursor so the next query re-reads the
  // party from the top with new signed URLs, but keep what is on screen.
  const lastRefresh = useRef(refreshedAt);
  useEffect(() => {
    if (lastRefresh.current === refreshedAt) return;
    lastRefresh.current = refreshedAt;
    setCursor(undefined);
  }, [refreshedAt]);

  const page = useQuery(backendApi.slideshow.feed, {
    eventId,
    ...(cursor === undefined ? {} : { after: cursor }),
  });

  useEffect(() => {
    if (page === undefined) return;

    if (page.items.length === 0) {
      // Nothing new. Hold the cursor — asking again from the same place is what
      // makes the next approval arrive as a one-item page.
      return;
    }

    /*
     * Accumulating state, not derived state — which is exactly why it is set
     * here rather than computed during render. The playlist is the *union of
     * every page ever received*, and each page is a one-shot value the
     * subscription hands over once and never repeats. There is nothing to derive
     * it from: last page ∪ current page is only knowable by having kept it.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: a page is a one-shot event, and the union of pages is state.
    setItems((current) => {
      const merged = [...current];
      const byId = new Map(current.map((item) => [item.id, item] as const));
      for (const item of page.items) {
        if (byId.has(item.id)) {
          // A re-read after a refresh: keep the position, take the fresher URLs.
          const at = merged.findIndex((existing) => existing.id === item.id);
          if (at !== -1) merged[at] = item;
          continue;
        }
        merged.push(item);
      }
      return merged;
    });

    if (page.nextCursor !== undefined) setCursor(page.nextCursor);
  }, [page]);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item] as const)), [items]);

  // Read straight off the page rather than mirrored into state: it is only used
  // for the empty stage's wording, and a state mirror of a query result is an
  // extra render per subscription tick for no gain.
  return {
    items,
    byId,
    total: page?.total ?? items.length,
    loading: page === undefined && items.length === 0,
  };
}
