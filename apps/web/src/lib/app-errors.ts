/**
 * One sentence a guest at a party can act on, from whatever the backend threw.
 *
 * Convex functions raise `AppError`, a `ConvexError` carrying
 * `{ code, message }` (see `packages/backend/convex/lib/errors.ts`). The
 * **message** is already written for the person reading it — the backend is
 * careful that an unknown code and a revoked code produce identical copy — so
 * the job here is not to rewrite it but to:
 *
 * - branch on `code` where the UI has to *do* something different (sign in
 *   again, go back to the event list),
 * - keep anything that is not an `AppError` from leaking a stack trace or an
 *   internal string onto a phone screen.
 */

import { isAppError, type ErrorCode } from "@partybooth/backend";

export interface AppErrorView {
  readonly code: ErrorCode | "unknown";
  readonly message: string;
  /** Milliseconds until a `rateLimited` action may be retried, when given. */
  readonly retryAfterMs?: number;
}

const FALLBACK = "Something went wrong. Try again in a moment.";

export function toAppErrorView(error: unknown): AppErrorView {
  if (isAppError(error)) {
    const data = error.data;
    const retryAfterMs =
      typeof data["retryAfterMs"] === "number" ? data["retryAfterMs"] : undefined;
    return {
      code: data.code,
      message: data.message || FALLBACK,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  // A dropped WebSocket during a mutation is the single most likely failure at
  // a party on shared Wi-Fi, and "Failed to fetch" helps nobody.
  if (error instanceof Error && /network|fetch|offline|socket/i.test(error.message)) {
    return { code: "unknown", message: "You look offline. Check your signal and try again." };
  }

  return { code: "unknown", message: FALLBACK };
}

/** The message alone, for the common case. */
export function appErrorMessage(error: unknown): string {
  return toAppErrorView(error).message;
}

/**
 * Does this failure mean "your session is gone"?
 *
 * Both codes read as signed-out to a guest: `unauthenticated` is no session,
 * and `accountDeleted` is a session whose account has been scheduled for
 * removal. Either way the only useful next step is the sign-in screen.
 */
export function isSignedOutError(error: unknown): boolean {
  const code = toAppErrorView(error).code;
  return code === "unauthenticated" || code === "accountDeleted";
}
