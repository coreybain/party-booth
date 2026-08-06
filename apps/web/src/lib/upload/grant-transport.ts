/**
 * The browser side of the authenticated upload-grant bridge.
 *
 * Uploads used to request their grant with Convex's reactive WebSocket client.
 * A successful mutation is not resolved there until the client has also moved
 * its query snapshot past the mutation's commit timestamp. That read-your-own-
 * writes guarantee is useful for ordinary UI mutations, but it is the wrong
 * dependency for this one-shot preflight: on a suspended or reconnecting mobile
 * browser the server can issue the grant while the promise stays pending, so
 * the queue never advances beyond "Starting".
 *
 * The upload itself already crosses a same-origin HTTP route and exchanges the
 * session cookie for a Convex token. This bridge does the same for the grant,
 * returning the mutation result directly without waiting on a reactive query
 * transition. The Expo app still talks to Convex directly.
 */

import { RemoteAppError, type AppErrorView } from "@/lib/app-errors";
import { parseGrantResult, type GrantResult } from "@/lib/contracts";

import type { UploadGrantRequestArgs } from "@/lib/convex-api";

export const UPLOAD_GRANT_API_PATH = "/api/upload-grant";
export const UPLOAD_GRANT_TIMEOUT_MS = 15_000;

export type UploadGrantApiResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: AppErrorView };

const OFFLINE: AppErrorView = {
  code: "unknown",
  message: "You look offline. Check your signal and try again.",
};

const TIMED_OUT: AppErrorView = {
  code: "unknown",
  message: "That took too long to start. Check your signal and try again.",
};

const INVALID_RESPONSE: AppErrorView = {
  code: "unknown",
  message: "The upload could not start. Try again in a moment.",
};

/** Request one short-lived grant without coupling it to the reactive socket. */
export async function requestUploadGrant(
  args: UploadGrantRequestArgs,
  signal?: AbortSignal,
): Promise<GrantResult> {
  const request = new AbortController();
  let timedOut = false;

  const abortFromCaller = (): void => {
    request.abort();
  };
  if (signal?.aborted === true) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, UPLOAD_GRANT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(UPLOAD_GRANT_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      credentials: "same-origin",
      signal: request.signal,
    });
  } catch {
    if (signal?.aborted === true) {
      // The queue already moved to `cancelled`; let its caller keep that state.
      throw new Error("Upload cancelled.");
    }
    throw new RemoteAppError(timedOut ? TIMED_OUT : OFFLINE);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RemoteAppError(INVALID_RESPONSE);
  }

  const payload = body as Partial<UploadGrantApiResponse>;
  if (payload.ok !== true) {
    const error = (payload as { error?: AppErrorView }).error;
    throw new RemoteAppError(error && typeof error.message === "string" ? error : INVALID_RESPONSE);
  }

  try {
    return parseGrantResult((payload as { result: unknown }).result);
  } catch {
    throw new RemoteAppError(INVALID_RESPONSE);
  }
}
