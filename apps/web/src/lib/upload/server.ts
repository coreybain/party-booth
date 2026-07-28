import "server-only";

/**
 * The server half of the upload spine: configuration, and the one call that
 * tells Convex a file has landed.
 *
 * Everything here degrades rather than throws. `apps/web` has to `next build`
 * and boot with an **empty environment** (CONTRIBUTING → "CI has no secrets, and
 * that is a design constraint"), so an unset `UPLOADTHING_TOKEN` produces a
 * route handler that answers 503 with a sentence naming the variable, not a
 * module that fails to evaluate.
 *
 * ## Two credentials, two questions
 *
 * `UPLOADTHING_TOKEN` is what lets us store anything at all. `UPLOAD_CALLBACK_SECRET`
 * is what lets Convex believe that a completion call came from *this* route
 * handler rather than from a guest replaying the grant they were legitimately
 * handed (ADR 0004 §4). They are set in different dashboards — Vercel for this
 * app, Convex for the mutation — and either being wrong produces uploads that
 * reach storage and never leave `processing`, which is why both are checked up
 * front rather than at the moment of failure.
 *
 * ## Why a bare HTTP client and not the authenticated helpers
 *
 * `fetchAuthMutation` exchanges a first-party session cookie for a Convex
 * identity token. The completion callback arrives from UploadThing's servers and
 * has no cookie, no session and no user — by design, since it is a
 * server-to-server statement about storage, not an action taken by a person.
 * `media.completeUpload` is built for exactly that: it authenticates on the
 * shared secret and takes the acting user from the grant.
 */

import { envOptional, serverEnv, serverFeatures } from "@partybooth/env/server";
import { ConvexHttpClient } from "convex/browser";

import { backendApi, type UploadCompletionResult } from "@/lib/convex-api";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const convexUrl = envOptional(serverEnv, "CONVEX_URL");
const siteUrl = envOptional(serverEnv, "SITE_URL");

export interface UploadServerStatus {
  /** Can this deployment store a file at all? */
  readonly storageConfigured: boolean;
  /** Can it prove a completion callback is ours? */
  readonly callbackConfigured: boolean;
  /** Is there a Convex deployment to record the result in? */
  readonly backendConfigured: boolean;
  readonly ready: boolean;
  /** Variables still unset, for an error message a person can act on. */
  readonly missing: readonly string[];
}

export function uploadServerStatus(): UploadServerStatus {
  const storageConfigured = serverFeatures.uploadthing;
  const callbackConfigured = serverFeatures.uploadCallback;
  const backendConfigured = convexUrl !== undefined;

  const missing = [
    storageConfigured ? undefined : "UPLOADTHING_TOKEN",
    callbackConfigured ? undefined : "UPLOAD_CALLBACK_SECRET",
    backendConfigured ? undefined : "CONVEX_URL",
  ].filter((name): name is string => name !== undefined);

  return {
    storageConfigured,
    callbackConfigured,
    backendConfigured,
    ready: missing.length === 0,
    missing,
  };
}

/**
 * `true` when uploads can work end to end.
 *
 * Read once at module scope by the route handler because Vercel does not change
 * a function's environment while it is warm; the *reason* is recomputed on
 * demand so the 503 body is always current in local development.
 */
export const isUploadConfigured: boolean = uploadServerStatus().ready;

/**
 * Absolute URL UploadThing calls back on.
 *
 * It is normally detected from the incoming request, and that detection is
 * correct on Vercel. Setting it explicitly when `SITE_URL` is
 * configured removes the one failure mode that detection has: a preview
 * deployment behind a proxy that rewrites `Host`, where the callback goes to a
 * URL that resolves to nothing and every upload sits in `processing` for ever.
 */
export function uploadCallbackUrl(): string | undefined {
  if (siteUrl === undefined) return undefined;
  return new URL("/api/uploadthing", siteUrl).toString();
}

/** The storage token, or `undefined`. Never logged, never returned to a client. */
export function uploadThingToken(): string | undefined {
  return envOptional(serverEnv, "UPLOADTHING_TOKEN");
}

/* -------------------------------------------------------------------------- */
/* Telling Convex a file landed                                               */
/* -------------------------------------------------------------------------- */

/**
 * One client for the lifetime of the lambda. `ConvexHttpClient` is stateless
 * over HTTP, so this is a connection-pool convenience rather than a session.
 */
let cachedClient: ConvexHttpClient | undefined;

function convexClient(): ConvexHttpClient | undefined {
  if (convexUrl === undefined) return undefined;
  cachedClient ??= new ConvexHttpClient(convexUrl);
  return cachedClient;
}

export interface CompletedUploadFacts {
  /** The grant secret carried through the middleware's metadata. */
  readonly secret: string;
  /** Provider file key. **Server-only** — it must never reach a browser. */
  readonly fileKey: string;
  readonly byteSize: number;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}

export class UploadNotConfiguredError extends Error {
  override readonly name = "UploadNotConfiguredError";
  constructor(readonly missing: readonly string[]) {
    super(`Uploads are not configured on this deployment (missing: ${missing.join(", ")}).`);
  }
}

/**
 * Register a stored file against its grant.
 *
 * Deliberately **does not catch**. Two different failures could be swallowed
 * here and both need to be loud:
 *
 * - a transport failure (Convex cold, network blip) must propagate so
 *   UploadThing retries the callback — the mutation is idempotent on
 *   `(eventId, captureId)` precisely so that retrying is free;
 * - a refused callback secret is a misconfiguration that leaves every upload
 *   stuck in `processing`, and a swallowed one is a party where nothing appears
 *   and no error is anywhere.
 *
 * The four *outcomes* (`registered`, `duplicate`, `discarded`, `rejected`) are a
 * different matter: all four are returned, and all four are successes to the
 * caller. A completion callback that answers with an error is one the provider
 * retries for ever, and "this capture was withdrawn while the bytes were in
 * flight" is not a condition retrying will fix.
 */
export async function registerCompletedUpload(
  facts: CompletedUploadFacts,
): Promise<UploadCompletionResult> {
  const callbackSecret = envOptional(serverEnv, "UPLOAD_CALLBACK_SECRET");
  const client = convexClient();

  if (callbackSecret === undefined || client === undefined) {
    throw new UploadNotConfiguredError(uploadServerStatus().missing);
  }

  return await client.mutation(backendApi.media.completeUpload, {
    callbackSecret,
    secret: facts.secret,
    fileKey: facts.fileKey,
    byteSize: facts.byteSize,
    ...(facts.mimeType === undefined ? {} : { mimeType: facts.mimeType }),
    ...(facts.width === undefined ? {} : { width: facts.width }),
    ...(facts.height === undefined ? {} : { height: facts.height }),
    ...(facts.durationSeconds === undefined ? {} : { durationSeconds: facts.durationSeconds }),
  });
}
