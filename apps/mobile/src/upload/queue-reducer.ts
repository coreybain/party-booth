/**
 * The durable upload queue, as a pure reducer.
 *
 * Every change to what is waiting to be sent goes through here: the camera, the
 * library picker, the undo button, the engine, a foreground event, and the
 * hydration read on cold start. That is deliberate. A queue that survives a
 * crash, a force-quit and an aeroplane-mode round trip has exactly one hard
 * property — **the next state is a function of the previous state and one
 * event** — and the only way to be sure of it is to make the whole thing a
 * function you can call ten thousand times in Node.
 *
 * Three rules hold everywhere below:
 *
 * 1. **Illegal transitions are no-ops, never throws.** `captureStateMachine`
 *    from `@partybooth/contracts/media` is the authority, and a double-tapped
 *    Undo, a progress event that arrives after a cancel, or a success callback
 *    for something already terminal all have to be survivable. A party is not
 *    the place to discover a race.
 * 2. **`captureId` is the identity.** It is generated once, at capture, and is
 *    what makes the whole pipeline idempotent — the same id retried is the same
 *    media row, on the server as well as here.
 * 3. **Nothing here knows the time.** `now` is always an argument, so the tests
 *    can move the clock and the reducer cannot disagree with itself between two
 *    calls in the same frame.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import { captureStateMachine, type CaptureState } from "@partybooth/contracts/media";

import { normaliseDelayMs, sendAtFor } from "./countdown";
import {
  isTerminalCapture,
  type CaptureDraft,
  type QueueFailure,
  type QueueItem,
  type QueueState,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Admission                                                                  */
/* -------------------------------------------------------------------------- */

/** How a fresh capture should be scheduled, read off the guest's settings. */
export interface AdmissionPolicy {
  readonly autoSend: boolean;
  readonly undoDelayMs: number;
}

/**
 * Turn what the pipeline produced into a row the queue can run.
 *
 * The scheduling fields are computed here rather than accepted from the caller,
 * which is the whole reason `CaptureDraft` and `QueueItem` are different types:
 * a screen that could supply its own `sendAt` is a screen that can put a send
 * time in the past, and the symptom is a photo that skips its undo window on one
 * device and not another.
 *
 * Every capture starts in `captured` — including one with a zero-length undo
 * window. The `tick` that follows moves it on within a frame, and going through
 * the state costs nothing while skipping it would give the two paths different
 * shapes for the Photos tab to handle.
 */
export function queueItemFromDraft(
  draft: CaptureDraft,
  policy: AdmissionPolicy,
  now: number,
): QueueItem {
  const undoDelayMs = normaliseDelayMs(policy.undoDelayMs);
  const sendAt = sendAtFor(draft.capturedAt, undoDelayMs);

  return {
    ...draft,
    state: "captured",
    autoSend: policy.autoSend,
    undoDelayMs,
    sendAt,
    attempts: 0,
    nextAttemptAt: sendAt,
    progress: 0,
    updatedAt: now,
  };
}

/* -------------------------------------------------------------------------- */
/* Retry policy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Backoff between automatic attempts.
 *
 * The first two steps are short because the overwhelmingly common failure at a
 * party is a saturated access point for four seconds, not a broken server. The
 * tail is long because the second most common one is a phone that has walked out
 * of range of the wifi and is on a train.
 */
export const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 45_000, 120_000] as const;

/**
 * Attempts before the engine stops trying on its own.
 *
 * It does not give up — the item stays `failed`, keeps its file, survives a
 * restart, and offers a manual retry. What stops is the timer, because an item
 * that has failed eight times is failing for a reason a ninth attempt will not
 * fix, and a phone in someone's pocket should not spend the evening on it.
 */
export const MAX_AUTO_ATTEMPTS = RETRY_BACKOFF_MS.length + 3;

export function backoffMsFor(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 2_000;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

export type QueueAction =
  /** The on-disk queue has been read. Also reconciles anything left mid-flight. */
  | { readonly type: "hydrate"; readonly items: readonly QueueItem[]; readonly now: number }
  /** A fresh capture or library import, already through the derivative pipeline. */
  | { readonly type: "enqueue"; readonly item: QueueItem }
  /** "Send now" — skip the rest of the undo window. */
  | { readonly type: "send"; readonly captureId: string; readonly now: number }
  /** The undo button, inside the window. */
  | { readonly type: "undo"; readonly captureId: string; readonly now: number }
  /** Abandon something already queued, uploading or failed. */
  | { readonly type: "cancel"; readonly captureId: string; readonly now: number }
  /** Manual retry from the Photos tab. Clears the backoff and the failure. */
  | { readonly type: "retry"; readonly captureId: string; readonly now: number }
  /** The clock moved: expire undo windows and mature backoffs. */
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "uploadStarted"; readonly captureId: string; readonly now: number }
  | { readonly type: "uploadProgress"; readonly captureId: string; readonly progress: number }
  | {
      readonly type: "uploadSucceeded";
      readonly captureId: string;
      readonly mediaId: string | null;
      readonly now: number;
    }
  | {
      readonly type: "uploadFailed";
      readonly captureId: string;
      readonly failure: QueueFailure;
      /** Honoured over the backoff table — the server said how long to wait. */
      readonly retryAfterMs?: number | undefined;
      readonly now: number;
    }
  /** The app came back to the foreground, or the process restarted. */
  | { readonly type: "resume"; readonly now: number }
  /** Drop terminal rows once their local files are gone. */
  | { readonly type: "forget"; readonly captureIds: readonly string[] };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apply `change` to one item, if the state move it implies is legal.
 *
 * Returns the same array reference when nothing changed, so React's `useReducer`
 * can bail out of a re-render for the very common "tick with nothing to do".
 */
function updateItem(
  items: readonly QueueItem[],
  captureId: string,
  change: (item: QueueItem) => QueueItem | null,
): readonly QueueItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.captureId !== captureId) return item;
    const updated = change(item);
    if (updated === null || updated === item) return item;
    changed = true;
    return updated;
  });
  return changed ? next : items;
}

/** A move that respects the contract's machine, or `null` if it does not. */
function moveTo(item: QueueItem, state: CaptureState, now: number): QueueItem | null {
  if (item.state === state) return null;
  if (!captureStateMachine.canTransition(item.state, state)) return null;
  return { ...item, state, updatedAt: now };
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                    */
/* -------------------------------------------------------------------------- */

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "hydrate": {
      // Anything the previous process left `uploading` is not in flight — the
      // request died with the process. Putting it back to `queued` is what makes
      // "foreground resume" true across a cold start rather than only across a
      // backgrounding, and it is why the state on disk is never trusted as-is.
      const items = action.items.map((item) =>
        item.state === "uploading"
          ? { ...item, state: "queued" as const, progress: 0, updatedAt: action.now }
          : item,
      );
      return { hydrated: true, items };
    }

    case "enqueue": {
      // Re-taking the same captureId would silently replace a file already in
      // flight; ids are generated per capture, so a collision is a bug upstream
      // and dropping the duplicate is the conservative answer.
      if (state.items.some((item) => item.captureId === action.item.captureId)) return state;
      return { ...state, items: [...state.items, action.item] };
    }

    case "send": {
      const items = updateItem(state.items, action.captureId, (item) => {
        const moved = moveTo(item, "queued", action.now);
        // `sendAt` moves too: it is what the countdown ring reads, and leaving it
        // in the future would draw a timer over something already uploading.
        return moved === null ? null : { ...moved, sendAt: action.now, nextAttemptAt: action.now };
      });
      return items === state.items ? state : { ...state, items };
    }

    case "undo":
    case "cancel": {
      const items = updateItem(state.items, action.captureId, (item) =>
        moveTo(item, "cancelled", action.now),
      );
      return items === state.items ? state : { ...state, items };
    }

    case "retry": {
      const items = updateItem(state.items, action.captureId, (item) => {
        const moved = moveTo(item, "queued", action.now);
        if (moved === null) return null;
        // A hand-driven retry means "now", so the backoff and the previous
        // failure both go. `attempts` deliberately survives: it is the honest
        // count of how many times this file has been pushed at the network, and
        // resetting it would let a manual tap re-arm the whole automatic ladder.
        const { failure: _failure, ...rest } = moved;
        return { ...rest, nextAttemptAt: action.now, progress: 0 };
      });
      return items === state.items ? state : { ...state, items };
    }

    case "tick": {
      let changed = false;
      const items = state.items.map((item) => {
        // The undo window closing is the only automatic `captured → queued`, and
        // it only applies to captures that were taken under auto-send. With the
        // toggle off, nothing but a tap moves this row.
        if (item.state === "captured" && item.autoSend && action.now >= item.sendAt) {
          changed = true;
          return { ...item, state: "queued" as const, updatedAt: action.now };
        }
        return item;
      });
      return changed ? { ...state, items } : state;
    }

    case "uploadStarted": {
      const items = updateItem(state.items, action.captureId, (item) => {
        const moved = moveTo(item, "uploading", action.now);
        return moved === null ? null : { ...moved, attempts: item.attempts + 1, progress: 0 };
      });
      return items === state.items ? state : { ...state, items };
    }

    case "uploadProgress": {
      const clamped = Math.min(1, Math.max(0, action.progress));
      const items = updateItem(state.items, action.captureId, (item) => {
        // Progress on something that is no longer uploading is a late event from
        // an aborted request. Ignoring it is what stops a cancelled row growing
        // a progress bar again.
        if (item.state !== "uploading") return null;
        // `updatedAt` deliberately does not move: progress is not a state change,
        // and touching it would rewrite the persisted queue on every chunk.
        return { ...item, progress: clamped };
      });
      return items === state.items ? state : { ...state, items };
    }

    case "uploadSucceeded": {
      const items = updateItem(state.items, action.captureId, (item) => {
        const moved = moveTo(item, "uploaded", action.now);
        if (moved === null) return null;
        const { failure: _failure, ...rest } = moved;
        return {
          ...rest,
          progress: 1,
          ...(action.mediaId === null ? {} : { mediaId: action.mediaId }),
        };
      });
      return items === state.items ? state : { ...state, items };
    }

    case "uploadFailed": {
      const items = updateItem(state.items, action.captureId, (item) => {
        const moved = moveTo(item, "failed", action.now);
        if (moved === null) return null;
        const wait = action.retryAfterMs ?? backoffMsFor(item.attempts);
        return {
          ...moved,
          failure: action.failure,
          progress: 0,
          nextAttemptAt: action.now + Math.max(0, wait),
        };
      });
      return items === state.items ? state : { ...state, items };
    }

    case "resume": {
      // Same reconciliation as hydration, for the case where the process lived
      // but the request did not: iOS suspends a backgrounded app mid-socket, and
      // what comes back is a promise that will never settle.
      let changed = false;
      const items = state.items.map((item) => {
        if (item.state !== "uploading") return item;
        changed = true;
        return { ...item, state: "queued" as const, progress: 0, updatedAt: action.now };
      });
      return changed ? { ...state, items } : state;
    }

    case "forget": {
      if (action.captureIds.length === 0) return state;
      const drop = new Set(action.captureIds);
      const items = state.items.filter((item) => !drop.has(item.captureId));
      return items.length === state.items.length ? state : { ...state, items };
    }

    default: {
      // Exhaustive: adding an action without a case is a compile error here.
      const never: never = action;
      void never;
      return state;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

/** Newest first — the order both the countdown banner and the list want. */
export function sortQueue(items: readonly QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => b.capturedAt - a.capturedAt);
}

export function findItem(items: readonly QueueItem[], captureId: string): QueueItem | undefined {
  return items.find((item) => item.captureId === captureId);
}

/** Everything for one party. The queue is global; the UI is always per-event. */
export function itemsForEvent(
  items: readonly QueueItem[],
  eventId: string | null | undefined,
): QueueItem[] {
  if (eventId === null || eventId === undefined) return [];
  return sortQueue(items.filter((item) => item.eventId === eventId));
}

/** The one the camera screen shows an Undo button for: newest still-undoable. */
export function undoableItem(
  items: readonly QueueItem[],
  eventId: string | null | undefined,
): QueueItem | undefined {
  return itemsForEvent(items, eventId).find((item) => item.state === "captured");
}

/**
 * Items whose local files may be deleted and whose rows may be forgotten.
 *
 * The two terminal states get different windows on purpose. An **undone**
 * capture should stop existing quickly: the guest has just said they did not
 * want it, and leaving a full-resolution photo of it on disk for five minutes is
 * both a storage cost and a small privacy one. An **uploaded** capture is kept
 * longer, because its local thumbnail is what the Photos tab draws in the gap
 * between "the server has a row" and "the server has a derivative to show".
 */
export interface ForgetPolicy {
  readonly uploadedKeepMs: number;
  readonly cancelledKeepMs: number;
}

export function forgettableItems(
  items: readonly QueueItem[],
  now: number,
  policy: ForgetPolicy,
): QueueItem[] {
  return items.filter((item) => {
    if (!isTerminalCapture(item.state)) return false;
    const keepFor = item.state === "cancelled" ? policy.cancelledKeepMs : policy.uploadedKeepMs;
    return now - item.updatedAt >= keepFor;
  });
}

/** How many of this party's captures are still on their way. */
export function pendingCountForEvent(
  items: readonly QueueItem[],
  eventId: string | null | undefined,
): number {
  return itemsForEvent(items, eventId).filter((item) => !isTerminalCapture(item.state)).length;
}
