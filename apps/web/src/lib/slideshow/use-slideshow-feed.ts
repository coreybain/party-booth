"use client";

import { useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { backendApi, type MediaItem } from "@/lib/convex-api";

/**
 * The slideshow's live feed: every approved item, in approval order.
 *
 * `slideshow.feed` is cursored and that is the interesting part. A Convex query
 * re-runs when its *data* changes, so the subscription held here fires every
 * time anybody approves anything — and because the cursor is where the show has
 * got to, the answer to "what changed?" is a page containing **only the new
 * items**. An empty page is the normal case and the whole point: it is what
 * keeps the photograph currently on the television on the television, instead of
 * restarting the show every time a host taps Approve.
 *
 * ## Adding, and removing
 *
 * A cursor can only ever add, so the accumulation rule used to be "never drop an
 * item once it has been seen", with the reasoning that a host who takes
 * something down mid-party "will not be soothed by watching it disappear ten
 * seconds later". That is the right instinct for the accidental case and exactly
 * the wrong one for the abuse case — which is what `moderate` and
 * `resolveReport` exist to handle. Decline and revoke do not delete the stored
 * object, so the URL already minted stayed live for its full ten-minute TTL: a
 * reported photograph kept cycling on the television for ten minutes after the
 * host removed it, then degraded into a skipped broken image.
 *
 * So the feed now **reconciles**. Every page carries `approvedIds` — the
 * authoritative approved set for this viewer, computed from the same scan that
 * produces `total` — and anything accumulated that is not in it comes off the
 * wall immediately. Additions still arrive through the cursor, so the common
 * case is unchanged and costs nothing.
 *
 * `approvedIdsComplete` is the guard on that: a party larger than the server's
 * cap sends a truncated list, and pruning against a truncated list would delete
 * the show. When it is `false` the hook adds and never removes, which is the old
 * behaviour, and the five-minute refresh remains the backstop.
 *
 * `refreshedAt` exists for the one thing a cursor cannot solve: signed URLs
 * expire on a clock, and a subscription that has been idle for twelve minutes is
 * holding URLs that stopped working two minutes ago (ADR 0004 §5). Changing it
 * re-runs the whole feed from the start and re-mints every URL.
 */

export interface SlideshowFeed {
  /** Everything currently approved that this client has been sent. */
  readonly items: readonly MediaItem[];
  readonly byId: ReadonlyMap<string, MediaItem>;
  /** Approved items in the event, as the server counts them. */
  readonly total: number;
  readonly loading: boolean;
}

export function useSlideshowFeed(eventId: string, refreshedAt = 0): SlideshowFeed {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<readonly MediaItem[]>([]);

  /*
   * A change of event is a different show.
   *
   * Nothing here is scoped to `eventId` by construction — the cursor is an
   * opaque string and the items are plain rows — so without this, switching the
   * active event kept one party's accumulated playlist, and its still-valid
   * signed URLs, under the next party's name. The component keys the stage as
   * well; this is the half that holds even if a caller forgets to.
   */
  const lastEvent = useRef(eventId);
  const lastRefresh = useRef(refreshedAt);
  useEffect(() => {
    if (lastEvent.current === eventId) return;
    lastEvent.current = eventId;
    lastRefresh.current = refreshedAt;
    setCursor(undefined);
    setItems([]);
  }, [eventId, refreshedAt]);

  // A refresh is a fresh start: drop the cursor so the next query re-reads the
  // party from the top with new signed URLs, but keep what is on screen.
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
    if (lastEvent.current !== eventId) return;

    /*
     * Accumulating state, not derived state — which is exactly why it is set
     * here rather than computed during render. The playlist is the *union of
     * every page ever received*, minus whatever has since stopped being
     * approved, and each page is a one-shot value the subscription hands over
     * once and never repeats. There is nothing to derive it from.
     */
    setItems((current) => {
      const approved = page.approvedIdsComplete ? new Set<string>(page.approvedIds) : undefined;
      // Removal first: an item the host has just taken down must not survive
      // because this page happened to be empty.
      const kept =
        approved === undefined ? current : current.filter((item) => approved.has(item.id));

      if (page.items.length === 0) {
        return kept.length === current.length ? current : kept;
      }

      const merged = [...kept];
      const at = new Map(kept.map((item, index) => [item.id, index] as const));
      for (const item of page.items) {
        const index = at.get(item.id);
        if (index !== undefined) {
          // A re-read after a refresh: keep the position, take the fresher URLs.
          merged[index] = item;
          continue;
        }
        at.set(item.id, merged.length);
        merged.push(item);
      }
      return merged;
    });

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the cursor is the position in a stream of one-shot pages; there is nothing to derive it from.
    if (page.items.length > 0 && page.nextCursor !== undefined) setCursor(page.nextCursor);
  }, [page, eventId]);

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
