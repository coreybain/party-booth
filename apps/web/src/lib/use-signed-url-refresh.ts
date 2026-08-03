"use client";

import { useNow } from "@/lib/use-now";

export const SIGNED_URL_REFRESH_FRACTION = 0.75;
export const MIN_SIGNED_URL_REFRESH_INTERVAL_MS = 1_000;

export function signedUrlRefreshIntervalMs(ttlSeconds: number): number {
  return Math.max(
    MIN_SIGNED_URL_REFRESH_INTERVAL_MS,
    Math.floor(ttlSeconds * 1_000 * SIGNED_URL_REFRESH_FRACTION),
  );
}

/**
 * Change a harmless Convex query argument before its signed URLs expire.
 * Convex subscriptions react to data changes, not time, so this gives a long-
 * lived gallery a fresh query identity and causes the server to mint new URLs.
 */
export function useSignedUrlRefreshKey(ttlSeconds: number): number {
  const intervalMs = signedUrlRefreshIntervalMs(ttlSeconds);
  const now = useNow(intervalMs);
  return Math.floor(now / intervalMs);
}
