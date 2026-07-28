/**
 * Where a tapped notification takes you.
 *
 * A notification that opens the app on whatever screen it happened to be on is
 * a notification that wasted the tap. Each of the three things PartyBooth sends
 * has exactly one place that answers it, and the mapping is a pure function of
 * the payload so it can be a table in a test rather than a thing you verify by
 * sending yourself pings.
 *
 * | notification                  | lands on   | because                                  |
 * | ----------------------------- | ---------- | ---------------------------------------- |
 * | upload failed / recovered     | My media   | that is where the retry button is        |
 * | party opened                  | Camera     | the answer to "it's live" is take a photo |
 * | party wrapped up              | Photos     | nothing left to send; the gallery remains |
 * | queue built up (host)         | Host       | the pending queue is the whole message   |
 *
 * ## The payload is not ours to invent
 *
 * The `data` object is written by `packages/backend/convex/lib/notifications.ts`
 * and both halves of it now live in `@partybooth/contracts/push` — the backend
 * builds it with `uploadStatusPayload` and friends, this file reads it with
 * {@link parsePushPayload}. Neither side spells a key, so the routing table
 * cannot drift from the thing that fills it.
 *
 * The parser is deliberately defensive: an unknown `kind`, a missing field or a
 * payload from a newer server than this build all produce `null`, and a `null`
 * route means "just open the app", which is the behaviour a notification had
 * before any of this existed.
 */

import { parsePushPayload, type PushPayload } from "@partybooth/contracts/push";

export { parsePushPayload, type PushPayload };

/** The tab a notification opens. These are `expo-router` paths, not screen names. */
export type PushRoutePath = "/camera" | "/photos" | "/host";

export interface PushRoute {
  readonly path: PushRoutePath;
  /**
   * The party the notification is about, when it named one.
   *
   * Acted on **before** navigating: a host with two parties who is told one of
   * them has a queue must land on that one's queue, and the Host tab renders
   * whatever the shell's active event is. Navigating first would show them the
   * wrong party for a frame and, if the switch failed, for ever.
   */
  readonly eventId: string | null;
}

/**
 * The previous name for {@link parsePushPayload}, kept so call sites and tests
 * written against the mobile-local parser still read.
 */
export const parsePushData = parsePushPayload;

/** The table above, as code. `null` means "open the app and change nothing". */
export function routeForPush(data: unknown): PushRoute | null {
  const payload = parsePushPayload(data);
  if (payload === null) return null;

  switch (payload.kind) {
    case "uploadStatus":
      // Both halves of the pair land here. "It failed" needs the retry button;
      // "it sent after all" needs the same row to show the guest it is true.
      return { path: "/photos", eventId: payload.eventId };

    case "eventLifecycle":
      return {
        // A closed party has nothing to point a camera at, and the Camera tab
        // would greet them with a disabled shutter. The gallery is what is left.
        path: payload.transition === "closed" ? "/photos" : "/camera",
        eventId: payload.eventId,
      };

    case "hostPendingThreshold":
      return { path: "/host", eventId: payload.eventId };
  }
}
