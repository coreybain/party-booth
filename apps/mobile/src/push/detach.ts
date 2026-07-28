/**
 * The one seam between signing out and giving up the push token.
 *
 * The ordering constraint is what makes this awkward enough to need a module.
 * `push.unregisterDevice` is an **authenticated** mutation, so it has to run
 * *before* Better Auth tears the session down — but the thing that knows the
 * token is the push provider, which is mounted *below* the session provider and
 * therefore cannot be reached from `signOut`.
 *
 * A registry of one is the smallest thing that works, and it is honest about
 * what it is: the provider publishes its detach function on mount and withdraws
 * it on unmount, and `signOut` awaits whatever is published. When nothing is —
 * an unconfigured build, or a test that renders a screen on its own — it is a
 * no-op, which is exactly right.
 *
 * Failure is deliberately swallowed. A guest tapping Sign out must always end up
 * signed out; a token that outlives the session is a row that goes quiet by
 * itself the next time Expo reports `DeviceNotRegistered`, and re-registering
 * under the next account **reassigns** it (see `convex/push.ts`), so the worst
 * case is bounded and small. Being unable to sign out is not.
 */

import { captureHandledError } from "../lib/sentry";

type DetachHandler = () => Promise<void>;

let handler: DetachHandler | null = null;

/** Publish (or withdraw, with `null`) the handler `signOut` will await. */
export function setPushDetachHandler(next: DetachHandler | null): void {
  handler = next;
}

/** Give up this device's push token, if there is one and anybody is listening. */
export async function detachPushDevice(): Promise<void> {
  if (handler === null) return;
  try {
    await handler();
  } catch (error) {
    captureHandledError(error, { scope: "push.detach" });
  }
}
