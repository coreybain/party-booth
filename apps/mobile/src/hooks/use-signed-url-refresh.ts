/**
 * Advance a harmless Convex query argument before its signed URLs expire.
 *
 * Convex subscriptions react to database changes, not the passage of time. A
 * gallery can therefore hold the same result after every URL in it has expired.
 * The backend accepts `urlRefreshKey` on signed-URL query paths and deliberately
 * ignores its value; changing it gives the subscription a new identity and
 * causes the server to permission-check and mint the URLs again.
 *
 * Refreshing at three quarters of the server TTL leaves room for the round trip
 * and clock skew. The time-bucket key also changes between distant remounts, so
 * reopening a screen cannot accidentally reuse its original cache key forever.
 */

import { useNow } from "@/hooks/use-now";

export const SIGNED_URL_REFRESH_FRACTION = 0.75;
export const MIN_SIGNED_URL_REFRESH_INTERVAL_MS = 1_000;

export function signedUrlRefreshIntervalMs(ttlSeconds: number): number {
  return Math.max(
    MIN_SIGNED_URL_REFRESH_INTERVAL_MS,
    Math.floor(ttlSeconds * 1_000 * SIGNED_URL_REFRESH_FRACTION),
  );
}

export function useSignedUrlRefreshKey(ttlSeconds: number): number {
  const intervalMs = signedUrlRefreshIntervalMs(ttlSeconds);
  const now = useNow(intervalMs);
  return Math.floor(now / intervalMs);
}
