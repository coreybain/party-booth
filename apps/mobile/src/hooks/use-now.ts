/**
 * The current time, as a value a component may read during render.
 *
 * Two reasons this is a hook rather than a bare `Date.now()`:
 *
 *   1. **Purity.** `Date.now()` in a render body makes the output depend on when React
 *      happened to re-render, which is a rule React's own lint rules refuse — and the
 *      practical symptom is two components on one screen disagreeing about whether the
 *      party has started.
 *   2. **It has to tick.** "Starts in a moment" has to become "Started" without the
 *      guest backing out and coming in again. A party is exactly the situation where
 *      somebody is staring at that line waiting for it to change.
 *
 * A minute is the right granularity: every string built from this
 * (`describeSchedule`, `describeJoinWindow`) is rounded to minutes, so a faster timer
 * would re-render for no visible change.
 */

import { useEffect, useState } from "react";

export const MINUTE_MS = 60_000;

export function useNow(intervalMs: number = MINUTE_MS): number {
  // Lazy initialiser: read once, on mount, rather than on every render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
