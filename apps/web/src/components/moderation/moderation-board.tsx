"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { BackendGate } from "@/components/backend-gate";
import { Card, Placeholder } from "@/components/layout/card";
import { StorageCallouts } from "@/components/media/storage-callouts";
import { FlaggedPanel } from "@/components/moderation/flagged-panel";
import { ModerationCard } from "@/components/moderation/moderation-card";
import { ModerationFilterBar } from "@/components/moderation/moderation-filter-bar";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { isHostRole, type ModerationActionName } from "@/lib/contracts";
import { backendApi, type MediaItem } from "@/lib/convex-api";
import {
  countModerationRows,
  DEFAULT_MODERATION_FILTERS,
  submitterOptions,
  visibleModerationRows,
  type ModerationFilters,
} from "@/lib/moderation/filters";
import {
  actionAvailability,
  describeModerationResult,
  emptySelection,
  selectedInOrder,
  selectionReducer,
} from "@/lib/moderation/selection";
import { useNow } from "@/lib/use-now";

/**
 * The moderation grid — the screen a host has open all night.
 *
 * PLAN.md: *"Moderation: masonry grid, approve/decline, filters, bulk select"*,
 * with keyboard review and submitter grouping "if time allows". All of it is
 * here, and the reasons for the shape are these:
 *
 * - **Everything reactive comes from one query.** `media.eventMedia` is the live
 *   list; filtering, ordering, counting and selection are all derived from it by
 *   pure functions in `lib/moderation/`. There is no second copy of the list to
 *   fall out of date, and every rule that decides what a host sees is unit
 *   tested without a browser.
 * - **The grid is a masonry column flow**, not a fixed grid of squares. Party
 *   photos are portrait and landscape in roughly equal measure, and square
 *   thumbnails crop faces out of exactly the shots a host is trying to judge.
 * - **The DOM is bounded.** A live party is capped at 200 rows by the query, and
 *   this renders them a page at a time behind an `IntersectionObserver`
 *   sentinel: scrolling reveals more, nothing off-screen is mounted, and no
 *   signed URL is fetched for a card nobody has scrolled to.
 * - **Nothing is optimistic.** An approve waits for Convex and reports what
 *   actually happened, including the partial refusals `ModerationResult` itemises
 *   — because at a party the reason an item refuses is usually another host, and
 *   a UI that lied about it would have the two of them fighting over a card.
 *
 * Keyboard review, since the host's other hand is holding a drink: **arrows**
 * move the cursor, **A** approves, **D** declines, **R** takes down, **X** or
 * **space** selects, **Escape** clears, **⌘/Ctrl-A** selects everything shown.
 * When something is selected the letters act on the *selection*; otherwise on
 * the card under the cursor. Left/right and up/down are both ±1 by design: in a
 * masonry column flow there is no "row" for up and down to mean.
 */

/** How many cards to mount at a time. */
const PAGE_SIZE = 60;

/** The most the query will return. Matches `listEventMediaInputSchema`. */
const QUERY_LIMIT = 200;

export function ActiveEventModeration() {
  return (
    <BackendGate>
      <ActiveEventModerationLive />
    </BackendGate>
  );
}

function ActiveEventModerationLive() {
  const active = useQuery(backendApi.events.activeEvent, {});

  if (active === undefined) {
    return (
      <Card>
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      </Card>
    );
  }

  if (active === null) {
    return (
      <Card>
        <Placeholder title="No event selected">
          Pick an event from the switcher at the top, or create one — moderation is always for one
          party at a time.
        </Placeholder>
      </Card>
    );
  }

  /*
   * A guest's active event, opened by somebody who is *also* an organiser
   * somewhere else — an ordinary situation, since the console gate only asks
   * whether you are an organiser at all.
   *
   * Checked here rather than left to fail: three of the queries below
   * (`moderation.flagged`, `media.storageStatus`) and every mutation are
   * host-only, and Convex refusing them mid-render takes the whole page to the
   * error boundary. The refusal is right; the crash is not the way to deliver
   * it.
   */
  if (!isHostRole(active.role)) {
    return (
      <Card>
        <Placeholder title="You're a guest at this party">
          Only the host and co-hosts moderate. Switch to an event you host, or open{" "}
          <Link href={`/event/${active.id}`}>the guest view</Link>.
        </Placeholder>
      </Card>
    );
  }

  return <ModerationBoardLive eventId={active.id} />;
}

function ModerationBoardLive({ eventId }: { readonly eventId: string }) {
  const media = useQuery(backendApi.media.eventMedia, { eventId, limit: QUERY_LIMIT });
  const flagged = useQuery(backendApi.moderation.flagged, { eventId, limit: 12 });
  const moderate = useMutation(backendApi.moderation.moderate);
  const now = useNow();

  const [filters, setFilters] = useState<ModerationFilters>(DEFAULT_MODERATION_FILTERS);
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "danger"; message: string } | undefined>(
    undefined,
  );

  const rows = useMemo<readonly MediaItem[]>(() => media ?? [], [media]);
  const counts = useMemo(() => countModerationRows(rows), [rows]);
  const submitters = useMemo(() => submitterOptions(rows), [rows]);
  const visible = useMemo(() => visibleModerationRows(rows, filters), [rows, filters]);
  const orderedIds = useMemo(() => visible.map((item) => item.id), [visible]);
  const orderedKey = orderedIds.join(",");

  /*
   * Reconcile the selection with what is actually on screen.
   *
   * Keyed on the joined id list rather than on the array, because the query
   * returns a new array identity on every subscription tick and this would
   * otherwise run — and re-render — several times a second at a busy party.
   */
  useEffect(() => {
    dispatch({ type: "reconcile", ordered: orderedKey === "" ? [] : orderedKey.split(",") });
  }, [orderedKey]);

  /**
   * A filter change is a different list, so it starts at the top rather than a
   * hundred cards down.
   *
   * Done here rather than in an effect on `filters`: an effect would fire a
   * second render on every change for something the event handler already knows,
   * and every path that changes a filter goes through this function.
   */
  const changeFilters = useCallback((next: ModerationFilters) => {
    setFilters(next);
    setLimit(PAGE_SIZE);
  }, []);

  const cardRefs = useRef(new Map<string, HTMLElement>());

  const runAction = useCallback(
    async (action: ModerationActionName, mediaIds: readonly string[]): Promise<void> => {
      if (mediaIds.length === 0) return;
      setBusy(true);
      try {
        const result = await moderate({ eventId, mediaIds, action });
        setNotice({ tone: "info", message: describeModerationResult(result) });
        // Only a bulk action clears: single taps are how a host works through a
        // queue, and clearing after each one would fight them.
        if (mediaIds.length > 1) dispatch({ type: "clear" });
      } catch (error) {
        setNotice({ tone: "danger", message: appErrorMessage(error) });
      } finally {
        setBusy(false);
      }
    },
    [eventId, moderate],
  );

  const act = useCallback(
    (action: ModerationActionName, ids: readonly string[]) => {
      void runAction(action, ids);
    },
    [runAction],
  );

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                               */
  /* ---------------------------------------------------------------------- */

  const selectedIds = useMemo(
    () => selectedInOrder(selection, orderedIds),
    [selection, orderedIds],
  );

  // A ref rather than a dependency: rebuilding the key handler on every
  // subscription tick would tear the listener down and put it back several times
  // a second, and a keypress landing in that gap is a keypress that does nothing.
  const latest = useRef({ selection, orderedIds, selectedIds, act, busy });
  useEffect(() => {
    latest.current = { selection, orderedIds, selectedIds, act, busy };
  }, [selection, orderedIds, selectedIds, act, busy]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "SELECT", "TEXTAREA", "VIDEO"].includes(target.tagName))
      ) {
        return;
      }

      const {
        selection: current,
        orderedIds: ordered,
        selectedIds: chosen,
        act: run,
      } = latest.current;
      if (ordered.length === 0) return;

      // ⌘/Ctrl-A is the only shortcut with a modifier; everything else with one
      // belongs to the browser.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        dispatch({ type: "selectAll", ordered });
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const targets =
        chosen.length > 0 ? chosen : current.focus === undefined ? [] : [current.focus];

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          dispatch({ type: "move", delta: 1, ordered });
          return;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          dispatch({ type: "move", delta: -1, ordered });
          return;
        case "Escape":
          dispatch({ type: "clear" });
          return;
        case " ":
        case "x":
        case "X":
          if (current.focus !== undefined) {
            event.preventDefault();
            dispatch({ type: "toggle", id: current.focus });
          }
          return;
        default:
          break;
      }

      if (latest.current.busy || targets.length === 0) return;

      switch (event.key.toLowerCase()) {
        case "a":
          event.preventDefault();
          run("approve", targets);
          break;
        case "d":
          event.preventDefault();
          run("decline", targets);
          break;
        case "r":
          event.preventDefault();
          run("revoke", targets);
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Keep the cursor on screen. `nearest` rather than `center` so working through
  // a queue does not scroll the page on every single card.
  useEffect(() => {
    if (selection.focus === undefined) return;
    cardRefs.current.get(selection.focus)?.scrollIntoView({ block: "nearest" });
  }, [selection.focus]);

  /* ---------------------------------------------------------------------- */
  /* Incremental rendering                                                  */
  /* ---------------------------------------------------------------------- */

  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setLimit((current) => current + PAGE_SIZE);
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [visible.length]);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                 */
  /* ---------------------------------------------------------------------- */

  if (media === undefined) {
    return (
      <Card>
        <p className="text-sm text-muted" role="status">
          Loading submissions…
        </p>
      </Card>
    );
  }

  const mounted = visible.slice(0, limit);

  return (
    <div className="space-y-4">
      <StorageCallouts eventId={eventId} processing={counts.processing} />

      {flagged !== undefined && flagged.length > 0 ? (
        <FlaggedPanel
          eventId={eventId}
          items={flagged}
          now={now}
          busy={busy}
          onAct={act}
          onShowAll={() => {
            changeFilters({
              ...DEFAULT_MODERATION_FILTERS,
              flaggedOnly: true,
              showDeclined: true,
            });
          }}
        />
      ) : null}

      <Card>
        <ModerationFilterBar
          filters={filters}
          counts={counts}
          submitters={submitters}
          shown={visible.length}
          onChange={changeFilters}
          onReset={() => {
            changeFilters(DEFAULT_MODERATION_FILTERS);
          }}
        />

        {notice !== undefined ? (
          <Callout tone={notice.tone} live="polite" className="mt-3">
            {notice.message}
          </Callout>
        ) : null}

        {visible.length === 0 ? (
          <Placeholder
            title={counts.total === 0 ? "Nothing yet" : "Nothing matches"}
            className="mt-5"
          >
            {counts.total === 0
              ? "Guests who have joined can add photos and video as soon as the event is live."
              : "No submissions match these filters. Reset them to see everything again."}
          </Placeholder>
        ) : (
          <>
            <div className="mt-5 columns-2 gap-3 sm:columns-3 lg:columns-4">
              {mounted.map((item) => (
                <ModerationCard
                  key={item.id}
                  ref={(node) => {
                    if (node === null) cardRefs.current.delete(item.id);
                    else cardRefs.current.set(item.id, node);
                  }}
                  item={item}
                  now={now}
                  busy={busy}
                  selected={selection.ids.has(item.id)}
                  focused={selection.focus === item.id}
                  onFocus={(id) => {
                    dispatch({ type: "focus", id });
                  }}
                  onToggleSelect={(id, extend) => {
                    dispatch(
                      extend ? { type: "extend", id, ordered: orderedIds } : { type: "toggle", id },
                    );
                  }}
                  onAct={act}
                />
              ))}
            </div>
            <div ref={sentinel} aria-hidden="true" className="h-4" />
            {mounted.length < visible.length ? (
              <p className="text-center text-xs text-faint" role="status">
                Showing {mounted.length} of {visible.length} — scroll for more.
              </p>
            ) : null}
          </>
        )}
      </Card>

      <SelectionBar
        rows={visible}
        selectedIds={selectedIds}
        busy={busy}
        onAct={act}
        onSelectAll={() => {
          dispatch({ type: "selectAll", ordered: orderedIds });
        }}
        onClear={() => {
          dispatch({ type: "clear" });
        }}
      />
    </div>
  );
}

/**
 * The bulk bar, pinned to the bottom of the viewport while a selection exists.
 *
 * Every count on it is what the action **would actually change** — run through
 * `moderationTransition`, the same rule the mutation applies — so "Approve 12"
 * never approves nine. An action that would move nothing is not offered.
 */
function SelectionBar({
  rows,
  selectedIds,
  busy,
  onAct,
  onSelectAll,
  onClear,
}: {
  readonly rows: readonly MediaItem[];
  readonly selectedIds: readonly string[];
  readonly busy: boolean;
  readonly onAct: (action: ModerationActionName, ids: readonly string[]) => void;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
}) {
  const chosen = useMemo(() => new Set(selectedIds), [selectedIds]);
  const approve = actionAvailability(rows, chosen, "approve");
  const decline = actionAvailability(rows, chosen, "decline");
  const revoke = actionAvailability(rows, chosen, "revoke");

  if (selectedIds.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Selected submissions"
      className="sticky bottom-3 z-10 mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      <span className="text-sm font-medium text-ink">{selectedIds.length} selected</span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {approve.changes > 0 ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              onAct("approve", selectedIds);
            }}
          >
            Approve {approve.changes}
          </Button>
        ) : null}
        {decline.changes > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              onAct("decline", selectedIds);
            }}
          >
            Decline {decline.changes}
          </Button>
        ) : null}
        {revoke.changes > 0 ? (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => {
              onAct("revoke", selectedIds);
            }}
          >
            Take down {revoke.changes}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          Select all
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
