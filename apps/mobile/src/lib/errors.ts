/**
 * Turning a thrown Convex error into a sentence.
 *
 * `packages/backend` throws `ConvexError` with a structured `{ code, message }`
 * payload precisely so a client can tell "sign in again" from "you can't do that"
 * without pattern-matching on prose. `isAppError` / `ErrorCode` are the backend's own
 * exported seam for that — using them rather than a local copy means a new code shows
 * up here as a compile error, not as a silent fall-through to "something went wrong".
 *
 * Messages from the backend are already written for a guest, so they are shown as-is
 * wherever they exist. What this module adds is the **action**: a code that needs the
 * user to sign in again is a different screen from one that just needs a retry, and
 * only the caller knows which button to render.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import { isAppError, type ErrorCode } from "@partybooth/backend";

/** What the UI should offer once the message has been shown. */
export type ErrorRecovery =
  /** Nothing to do but try the same thing again. */
  | "retry"
  /** The session is gone or the account is unusable — send them to sign-in. */
  | "signIn"
  /** A wait, not a mistake. The message carries how long. */
  | "wait"
  /** Permanent for this account or resource; retrying is cruel. */
  | "none";

export interface ErrorCopy {
  readonly title: string;
  readonly message: string;
  readonly recovery: ErrorRecovery;
  /** Present when the backend attached one to a `rateLimited` payload. */
  readonly retryAfterMs?: number;
}

const FALLBACK_MESSAGE = "Something went wrong. Check your connection and try again.";

const CODE_COPY: Record<ErrorCode, { title: string; recovery: ErrorRecovery }> = {
  unauthenticated: { title: "Sign in to continue", recovery: "signIn" },
  forbidden: { title: "Not allowed", recovery: "none" },
  notFound: { title: "Not found", recovery: "none" },
  // A lock is an admin action against this account: retrying cannot lift it, and
  // signing out and back in would only hide the explanation.
  accountLocked: { title: "Account locked", recovery: "none" },
  accountDeleted: { title: "Account closed", recovery: "signIn" },
  invalidState: { title: "Not right now", recovery: "none" },
  rateLimited: { title: "Too many tries", recovery: "wait" },
  // The app validates with the same contracts schemas the backend parses with, so
  // reaching this means the two disagree — worth retrying once, then reporting.
  invalidInput: { title: "That didn't look right", recovery: "retry" },
  notConfigured: { title: "Not set up yet", recovery: "none" },
};

const UNKNOWN_CODE_COPY = { title: "Something went wrong", recovery: "retry" } as const;

/**
 * Look the code up as a plain string.
 *
 * `CODE_COPY` is a total `Record<ErrorCode, …>` so adding a code to
 * `packages/backend` fails this file at compile time. The *lookup* is widened
 * because a deployment can be newer than the app on a guest's phone — an app that
 * throws on an unrecognised code is worse than one that says "try again".
 */
function copyFor(code: string): { title: string; recovery: ErrorRecovery } {
  return (
    (CODE_COPY as Record<string, { title: string; recovery: ErrorRecovery } | undefined>)[code] ??
    UNKNOWN_CODE_COPY
  );
}

function retryAfterFrom(data: Record<string, unknown>): number | undefined {
  const value = data.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Describe anything a Convex call can reject with.
 *
 * The network-failure case matters as much as the modelled ones: a party happens on
 * saturated Wi-Fi, and "check your connection" is the correct and most common answer.
 */
export function describeError(error: unknown): ErrorCopy {
  if (isAppError(error)) {
    const data: Record<string, unknown> = error.data;
    const code = typeof data.code === "string" ? data.code : "";
    const copy = copyFor(code);
    const retryAfterMs = retryAfterFrom(data);
    return {
      title: copy.title,
      message: typeof data.message === "string" && data.message ? data.message : FALLBACK_MESSAGE,
      recovery: copy.recovery,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  return {
    title: "Something went wrong",
    // Never surface a raw `Error.message` here: Convex puts internal detail in the
    // message of an unexpected server error, and a stack fragment on a guest's phone
    // is noise at best and a leak at worst. It goes to Sentry instead.
    message: FALLBACK_MESSAGE,
    recovery: "retry",
  };
}

/** True when the failure means the shell should drop back to the sign-in screen. */
export function requiresSignIn(error: unknown): boolean {
  return describeError(error).recovery === "signIn";
}
