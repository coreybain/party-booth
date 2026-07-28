"use client";

import { useSyncExternalStore } from "react";

import { browserTimeZone } from "./datetime";

/** Nothing to subscribe to: the browser's zone does not change mid-session. */
const noopSubscribe = () => () => {
  /* no teardown */
};

const serverSnapshot = () => "UTC";

const clientSnapshot = () => browserTimeZone() ?? "UTC";

/**
 * The browser's IANA time zone, hydration-safe.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is a *client* fact, and
 * reading it during render on both sides is a hydration mismatch — the server
 * says `UTC`, the browser says `Europe/London`, React complains and one of the
 * two wins arbitrarily.
 *
 * `useSyncExternalStore` is the sanctioned way to read exactly this kind of
 * value: React renders `getServerSnapshot` for the server pass and the
 * hydration pass, then re-renders with the client value. No effect, no
 * `setState` cascade, no mismatch.
 *
 * The snapshot is a plain string, so successive calls compare equal under
 * `Object.is` and React never loops.
 */
export function useBrowserTimeZone(): string {
  return useSyncExternalStore(noopSubscribe, clientSnapshot, serverSnapshot);
}
