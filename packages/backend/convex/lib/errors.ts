import { ConvexError, type Value } from "convex/values";

/**
 * Machine-readable failure codes.
 *
 * Clients branch on `code`, never on the message. The messages are what a guest
 * sees, so they stay vague where being specific would leak something (an
 * unknown code and a revoked code look identical from outside).
 */
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "notFound",
  "accountLocked",
  "accountDeleted",
  "invalidState",
  "rateLimited",
  "invalidInput",
  "notConfigured",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Payload shape. The index signature is required by `ConvexError`, which only
 * accepts values it can serialise across the wire — so `retryAfterMs` is
 * documented here rather than declared as an optional property.
 *
 * Known extras: `retryAfterMs` (milliseconds until a `rateLimited` action may
 * be retried).
 */
export interface AppErrorData {
  code: ErrorCode;
  message: string;
  [key: string]: Value;
}

/**
 * `ConvexError` carries a structured payload all the way to the client, which
 * plain `Error` does not — everything thrown on a request path should be one of
 * these so the UI can tell "sign in again" from "you can't do that".
 */
export class AppError extends ConvexError<AppErrorData> {
  constructor(code: ErrorCode, message: string, extra: Record<string, Value> = {}) {
    super({ code, message, ...extra });
  }
}

export const unauthenticated = (message = "Sign in to continue."): AppError =>
  new AppError("unauthenticated", message);

export const forbidden = (message = "You do not have permission to do that."): AppError =>
  new AppError("forbidden", message);

export const notFound = (what = "That"): AppError =>
  new AppError("notFound", `${what} could not be found.`);

export const invalidState = (message: string): AppError => new AppError("invalidState", message);

export const invalidInput = (message: string): AppError => new AppError("invalidInput", message);

export const rateLimited = (message: string, retryAfterMs: number): AppError =>
  new AppError("rateLimited", message, { retryAfterMs });

/** A provider (Resend, UploadThing, an OAuth client) has no credentials. */
export const notConfigured = (what: string): AppError =>
  new AppError(
    "notConfigured",
    `${what} is not configured on this deployment. Set the matching environment variables — run \`pnpm env:doctor\` for the list.`,
  );

export function isAppError(error: unknown): error is AppError {
  return (
    error instanceof ConvexError &&
    typeof (error.data as AppErrorData | undefined)?.code === "string"
  );
}
