/**
 * What the moderation grid shows, and in what order.
 *
 * Pure, and generic over anything `MediaItem`-shaped, for the reason
 * `media-view.ts` and `event-view.ts` are: `apps/web` has no DOM test
 * environment (PLAN.md puts browser-level testing in Sprint 6 behind
 * Playwright), so the parts of a screen worth being sure about are the parts
 * that can be tested without one. Filtering and ordering are exactly that — they
 * are also the parts a host will notice instantly if they are wrong at 1 a.m.
 *
 * Three decisions live here rather than in the component:
 *
 * 1. **Declined is hidden by default and is not the same thing as a filter.**
 *    `showDeclined` is a separate toggle from `status`, because "show me
 *    everything" at a party means "everything I still might act on", and a host
 *    scrolling past forty declined photos to find three pending ones is the
 *    failure this exists to prevent. Asking for `status: "declined"` explicitly
 *    overrides the toggle — a filter the host typed beats a default they did not.
 * 2. **Pending, newest first, is the default order**, because the queue is a
 *    stack: the photo somebody just took is the one people are standing around
 *    waiting to see on the television.
 * 3. **Flagged sorts above everything.** A reported item is the one decision with
 *    a clock on it, and burying it under sixty ordinary photos is how a host
 *    finds out about it from a guest instead of from the screen.
 *
 * Nothing here is a permission check. `canSeeMedia` runs in Convex and decides
 * what is in the array at all; this decides what a host is currently looking at.
 */

import type { MediaState, MediaType } from "@/lib/contracts";

/* -------------------------------------------------------------------------- */
/* The row shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The fields the grid actually sorts and filters on.
 *
 * A structural subset of `MediaItem` rather than the type itself, so a test
 * fixture is eight fields instead of twenty and so this module has no opinion
 * about signed URLs.
 */
export interface ModerationRow {
  readonly id: string;
  readonly state: MediaState;
  readonly mediaType: MediaType;
  readonly uploaderUserId: string;
  readonly uploaderDisplayName: string;
  readonly createdAt: number;
  /** Host-only, and absent until somebody reports the item. */
  readonly reportCount?: number;
  readonly flaggedAt?: number;
}

export function isFlagged(row: ModerationRow): boolean {
  return (row.reportCount ?? 0) > 0 || row.flaggedAt !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

/** `all` is not a media state — it is the absence of the filter. */
export type StatusFilter = "all" | MediaState;
export type TypeFilter = "all" | MediaType;

export interface ModerationFilters {
  readonly status: StatusFilter;
  readonly mediaType: TypeFilter;
  /** A `uploaderUserId`, or `all`. */
  readonly submitter: string;
  readonly flaggedOnly: boolean;
  /**
   * Declined items are hidden unless this is on — or unless `status` names them,
   * which is a host asking for them by hand.
   */
  readonly showDeclined: boolean;
}

export const DEFAULT_MODERATION_FILTERS: ModerationFilters = {
  status: "all",
  mediaType: "all",
  submitter: "all",
  flaggedOnly: false,
  showDeclined: false,
};

/**
 * Statuses a host can pick between.
 *
 * `deleted` is deliberately absent: a withdrawn item is gone from every list
 * `canSeeMedia` produces, so offering the filter would offer an option that
 * always returns nothing.
 */
export const STATUS_FILTER_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
  { value: "processing", label: "Uploading" },
];

export const TYPE_FILTER_OPTIONS: readonly { value: TypeFilter; label: string }[] = [
  { value: "all", label: "Photos & video" },
  { value: "photo", label: "Photos" },
  { value: "video", label: "Video" },
];

export function isDefaultFilters(filters: ModerationFilters): boolean {
  return (
    filters.status === DEFAULT_MODERATION_FILTERS.status &&
    filters.mediaType === DEFAULT_MODERATION_FILTERS.mediaType &&
    filters.submitter === DEFAULT_MODERATION_FILTERS.submitter &&
    filters.flaggedOnly === DEFAULT_MODERATION_FILTERS.flaggedOnly &&
    filters.showDeclined === DEFAULT_MODERATION_FILTERS.showDeclined
  );
}

/** Does this one row survive the current filters? */
export function matchesFilters(row: ModerationRow, filters: ModerationFilters): boolean {
  if (row.state === "deleted") return false;

  if (filters.status !== "all" && row.state !== filters.status) return false;

  // The declined toggle applies only when the host has *not* asked for declined
  // by name. Otherwise picking "Declined" from the status list would return an
  // empty grid, which reads as a broken filter rather than as a hidden one.
  if (row.state === "declined" && !filters.showDeclined && filters.status !== "declined") {
    return false;
  }

  if (filters.mediaType !== "all" && row.mediaType !== filters.mediaType) return false;
  if (filters.submitter !== "all" && row.uploaderUserId !== filters.submitter) return false;
  if (filters.flaggedOnly && !isFlagged(row)) return false;

  return true;
}

export function filterModerationRows<T extends ModerationRow>(
  rows: readonly T[],
  filters: ModerationFilters,
): T[] {
  return rows.filter((row) => matchesFilters(row, filters));
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which band a row sorts into. Lower comes first.
 *
 * The bands, and why they are in this order:
 *
 * - **0 — flagged and still pending.** Somebody reported it and nobody has
 *   decided. Nothing outranks that.
 * - **1 — pending.** The queue.
 * - **2 — flagged but already decided.** Worth a second look, not urgent.
 * - **3 — still uploading.** It will become pending on its own; there is nothing
 *   to press.
 * - **4 — approved**, **5 — declined.** History, newest first.
 */
export function moderationBand(row: ModerationRow): number {
  const flagged = isFlagged(row);
  if (row.state === "pending") return flagged ? 0 : 1;
  if (flagged) return 2;
  if (row.state === "processing") return 3;
  if (row.state === "approved") return 4;
  return 5;
}

/**
 * Band, then newest first, then id.
 *
 * The id tie-break is not decoration: at a party where fifty phones are firing,
 * two captures landing in the same millisecond is ordinary, and a comparator
 * that returns 0 for them lets the grid reshuffle itself on every subscription
 * tick — which, in a grid where the host is aiming at a card, is worse than any
 * ordering could be.
 */
export function compareForModeration(a: ModerationRow, b: ModerationRow): number {
  const band = moderationBand(a) - moderationBand(b);
  if (band !== 0) return band;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortForModeration<T extends ModerationRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareForModeration);
}

/** Filter, then order. What the grid renders. */
export function visibleModerationRows<T extends ModerationRow>(
  rows: readonly T[],
  filters: ModerationFilters,
): T[] {
  return sortForModeration(filterModerationRows(rows, filters));
}

/* -------------------------------------------------------------------------- */
/* Counts and options                                                         */
/* -------------------------------------------------------------------------- */

export interface ModerationCounts {
  readonly total: number;
  readonly pending: number;
  readonly approved: number;
  readonly declined: number;
  readonly processing: number;
  readonly flagged: number;
}

/**
 * Counted over the **unfiltered** list, on purpose: the chip that says "12
 * pending" has to keep saying so while the host is looking at approved items,
 * or it stops being the thing that tells them whether to keep moderating.
 */
export function countModerationRows(rows: readonly ModerationRow[]): ModerationCounts {
  let pending = 0;
  let approved = 0;
  let declined = 0;
  let processing = 0;
  let flagged = 0;

  for (const row of rows) {
    if (row.state === "deleted") continue;
    if (row.state === "pending") pending += 1;
    else if (row.state === "approved") approved += 1;
    else if (row.state === "declined") declined += 1;
    else if (row.state === "processing") processing += 1;
    if (isFlagged(row)) flagged += 1;
  }

  return {
    total: pending + approved + declined + processing,
    pending,
    approved,
    declined,
    processing,
    flagged,
  };
}

export interface SubmitterOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The submitter filter's options, busiest first.
 *
 * Busiest first rather than alphabetical because the reason a host opens this
 * list is almost always "one person is flooding the queue", and that person is
 * at the top.
 */
export function submitterOptions(rows: readonly ModerationRow[]): SubmitterOption[] {
  const byUser = new Map<string, SubmitterOption>();

  for (const row of rows) {
    if (row.state === "deleted") continue;
    const existing = byUser.get(row.uploaderUserId);
    byUser.set(row.uploaderUserId, {
      value: row.uploaderUserId,
      label: existing?.label ?? row.uploaderDisplayName,
      count: (existing?.count ?? 0) + 1,
    });
  }

  return [...byUser.values()].sort((a, b) =>
    a.count === b.count ? a.label.localeCompare(b.label) : b.count - a.count,
  );
}

/** "3 of 41 shown" — the sentence under the filter row. */
export function describeVisible(shown: number, total: number): string {
  if (total === 0) return "Nothing yet";
  if (shown === total) return shown === 1 ? "1 item" : `${String(shown)} items`;
  return `${String(shown)} of ${String(total)} shown`;
}
