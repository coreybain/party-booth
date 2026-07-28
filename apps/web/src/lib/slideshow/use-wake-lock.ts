"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Keep the screen awake while the slideshow is running.
 *
 * The Screen Wake Lock API, and nothing clever: `navigator.wakeLock.request("screen")`
 * returns a sentinel, and the browser takes it away again whenever the document
 * stops being visible — switching tabs, locking the phone, the OS deciding the
 * battery is low. That is not a failure, it is the specified behaviour, so the
 * only correct implementation **re-requests on `visibilitychange`** rather than
 * assuming the first request holds for five hours.
 *
 * Everything about it is best-effort by design:
 *
 * - It needs a secure context, so it silently does nothing on `http://` — which
 *   includes `next dev` on a LAN address, and is worth knowing before the party
 *   rather than during it.
 * - It can be refused outright (power saving, low battery), and a refusal is a
 *   caught promise rejection, not an exception to show anybody. The slideshow
 *   keeps playing; the television's own screensaver becomes the risk, which is a
 *   television setting rather than something a web page can fix.
 *
 * The returned flags exist so the slideshow can say "screen may sleep" quietly
 * in the corner instead of pretending it has a guarantee it does not have.
 */

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  released?: boolean;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/**
 * Read through a local shape rather than `lib.dom`'s.
 *
 * `WakeLock` has been in the DOM lib for a while, but this file has to compile
 * against whatever `lib` the app is configured with today and in a year, and the
 * cost of describing two methods here is lower than the cost of a build that
 * fails on a TypeScript upgrade for a browser API used in one place.
 */
function wakeLockApi(): WakeLockLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  const candidate = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  return typeof candidate?.request === "function" ? candidate : undefined;
}

export interface WakeLockState {
  /** Whether this browser has the API at all. */
  readonly supported: boolean;
  /** Whether a lock is held right now. */
  readonly active: boolean;
}

/** Nothing to subscribe to: whether the API exists never changes at runtime. */
const subscribeNever = (): (() => void) => () => undefined;

export function useWakeLock(enabled: boolean): WakeLockState {
  /*
   * `held` is written only from asynchronous callbacks — never synchronously in
   * an effect body — and the flag the caller reads is derived. That is what
   * keeps this hook out of the cascading-render trap `react-hooks` warns about:
   * turning the slideshow's pause on does not have to round-trip through a
   * render to report "no lock", because `enabled` already says so.
   */
  const [held, setHeld] = useState(false);

  // A browser-only value read the sanctioned way: the server snapshot is
  // `false`, so the first client render matches the HTML and nothing hydrates
  // differently.
  const supported = useSyncExternalStore(
    subscribeNever,
    useCallback(() => wakeLockApi() !== undefined, []),
    useCallback(() => false, []),
  );

  useEffect(() => {
    const api = wakeLockApi();
    if (!enabled || api === undefined) return;

    let sentinel: WakeLockSentinelLike | undefined;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await api.request("screen");
        if (cancelled) {
          void next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
        setHeld(true);
        next.addEventListener("release", () => {
          setHeld(false);
        });
      } catch {
        // Refused — power saving, low battery, or an insecure context. The show
        // carries on; only the guarantee is gone.
        setHeld(false);
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
      setHeld(false);
    };
  }, [enabled]);

  return { supported, active: enabled && held };
}
