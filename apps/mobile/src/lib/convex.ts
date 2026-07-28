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
 * **`expectAuth` is off, and that is a deliberate change from Sprint 1.** It pauses the
 * WebSocket until the first auth token arrives — but `ConvexProviderWithAuth` only ever
 * calls `setAuth` when the auth provider reports *authenticated*, so for a signed-out
 * user the socket stays paused forever and no query runs at all. Sprint 1 could not
 * tell, because every query it had was authenticated.
 *
 * Sprint 2 has one that must not be: `join.previewByToken` is unauthenticated on
 * purpose, so a guest who scans the QR sees whose party it is *before* deciding to sign
 * in. With `expectAuth: true` that screen hangs on a spinner, on the single most
 * important path in the product.
 *
 * The flash of unauthenticated results that `expectAuth` was avoiding is prevented
 * properly instead: `LiveSessionProvider` gates every authenticated query on
 * `useConvexAuth().isAuthenticated`, so none of them is issued before Convex itself
 * confirms the token. That is also stricter than what `expectAuth` gave us — it closes
 * the window where Better Auth has a session but Convex has not been told yet, in which
 * `events.myEvents` would have thrown `unauthenticated` during render.
 *
 * `unsavedChangesWarning` is a browser-only affordance and must be off in React Native.
 */
export function getConvexClient(convexUrl: string): ConvexReactClient {
  client ??= new ConvexReactClient(convexUrl, {
    expectAuth: false,
    unsavedChangesWarning: false,
  });
  return client;
}

/** Test/reset seam — drops the memoised client. */
export function resetConvexClient(): void {
  client = undefined;
}
