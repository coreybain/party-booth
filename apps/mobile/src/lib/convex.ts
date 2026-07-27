/**
 * Convex React client for apps/mobile.
 *
 * Created lazily and memoised: `ConvexReactClient` opens a WebSocket in its constructor
 * and throws on a malformed URL, so it must never be constructed at module scope where
 * an unconfigured checkout would crash on import.
 */

import { ConvexReactClient } from "convex/react";

let client: ConvexReactClient | undefined;

/**
 * Get (or create) the singleton Convex client.
 *
 * `expectAuth: true` holds queries until Better Auth has resolved the session, which
 * avoids a flash of "unauthenticated" results on every cold start.
 * `unsavedChangesWarning` is a browser-only affordance and must be off in React Native.
 */
export function getConvexClient(convexUrl: string): ConvexReactClient {
  client ??= new ConvexReactClient(convexUrl, {
    expectAuth: true,
    unsavedChangesWarning: false,
  });
  return client;
}

/** Test/reset seam — drops the memoised client. */
export function resetConvexClient(): void {
  client = undefined;
}
