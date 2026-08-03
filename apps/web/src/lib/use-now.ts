"use client";

import { useSyncExternalStore } from "react";

/**
 * A clock that is safe to render from.
 *
 * `Date.now()` in a render body is an impure read: React may re-render for
 * reasons that have nothing to do with time, two components rendering in one
 * commit can disagree about what "now" is, and the server's now is never the
 * browser's now — which is a hydration mismatch waiting for a slow network.
 *
 * The wall clock is an *external store*, so it is subscribed to as one. The
 * server snapshot is `0`, which renders every relative timestamp as its epoch
 * and corrects itself on the first client commit; React re-reads the snapshot
 * immediately after subscribing, which is what makes that correction happen
 * without a `setState` in an effect.
 *
 * One timer for the whole app, started on the first subscriber and stopped after
 * the last — a media grid with forty cards must not hold forty intervals.
 *
 * Thirty seconds is chosen against what `formatRelative` actually says: it
 * speaks in minutes, so a faster tick would re-render the grid to change
 * nothing.
 */
const TICK_MS = 30_000;

interface ClockStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

const clocks = new Map<number, ClockStore>();

function clockFor(intervalMs: number): ClockStore {
  const existing = clocks.get(intervalMs);
  if (existing !== undefined) return existing;

  let cached = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  function tick(): void {
    cached = Date.now();
    for (const listener of listeners) listener();
  }

  const store: ClockStore = {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === undefined) {
        cached = Date.now();
        timer = setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot() {
      return cached;
    },
  };
  clocks.set(intervalMs, store);
  return store;
}

/** `0` on the server and for the very first client render, then the wall clock. */
function getServerSnapshot(): number {
  return 0;
}

export function useNow(intervalMs = TICK_MS): number {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, getServerSnapshot);
}
