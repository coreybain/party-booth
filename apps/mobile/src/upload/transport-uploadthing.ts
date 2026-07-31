/**
 * The real transport: UploadThing, through the route handler in `apps/web`.
 *
 * A guest never holds an UploadThing credential and never talks to the provider
 * on their own authority (ADR 0004, "Alternatives considered"). The sequence is:
 *
 *   1. Convex issues a bound, single-use grant → `secret`.
 *   2. This module POSTs to **our** route handler at `{siteUrl}/api/uploadthing`,
 *      carrying the contract's `UploadTicket` as the route's `input`. The
 *      handler's `.middleware()` is where the grant inside it is checked; that
 *      handler is the only thing holding a provider token.
 *   3. The handler returns a presigned URL, the SDK PUTs the bytes, and the
 *      provider calls the handler back, which calls `media.completeUpload`.
 *
 * `genUploader` / `uploadFiles` is the current (v7) client API, verified against
 * `docs.uploadthing.com` and against the installed `uploadthing@7.7.4` type
 * definitions. `createUpload` — the resumable variant — is deliberately not used:
 * UploadThing document it as unsupported on React Native because of RN's Blob
 * implementation.
 *
 * ## The one cross-package contract
 *
 * The slug and the input shape have to match the `FileRouter` that `apps/web`
 * exports. Both now come from `@partybooth/contracts/upload`, so "match" is
 * something the compiler checks rather than something two people remember.
 */

import {
  UPLOAD_ROUTE_PATH,
  UPLOAD_ROUTE_SLUG,
  parseUploadCallbackResult,
  uploadCallbackSucceeded,
  type UploadCallbackResult,
  type UploadTicket,
} from "@partybooth/contracts/upload";
import { genUploader } from "uploadthing/client";

import {
  UploadCancelledError,
  UploadCompletionError,
  isAborted,
  isUploadCancelled,
  type UploadRequest,
  type UploadTransport,
} from "./transport";

import type { FileRoute } from "uploadthing/types";

/* -------------------------------------------------------------------------- */
/* The contract with apps/web                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The route slug, the path and the input shape are all
 * `@partybooth/contracts/upload`'s.
 *
 * They used to be declared here, on the argument that `apps/mobile` must not
 * depend on the website's build — which is true, and is why they now live in a
 * package **both** depend on rather than in a comment asking two people to keep
 * two files in step. They had already drifted: this app sent `{ secret }` and
 * the route handler has always parsed `uploadTicketSchema`, so every upload from
 * the app would have been refused by the middleware's own input validation
 * before a byte moved.
 */
export { UPLOAD_ROUTE_PATH, UPLOAD_ROUTE_SLUG };

/**
 * A structural description of the one route we call, in the shape
 * `genUploader` wants. The *content* of the input is the contract's
 * {@link UploadTicket}, so a change to the ticket is a compile error here rather
 * than a 4xx at a party.
 */
type PartyMediaRouter = {
  readonly [UPLOAD_ROUTE_SLUG]: FileRoute<{
    input: UploadTicket;
    output: UploadCallbackResult;
    errorShape: unknown;
  }>;
};

/* -------------------------------------------------------------------------- */
/* The transport                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the React-Native-shaped `File` the SDK expects.
 *
 * This is UploadThing's own documented Expo pattern: read the local file into a
 * (natively-backed, not JS-heap) Blob, wrap it in a `File` so the SDK can read
 * `name`/`size`/`type`, then attach `uri` — because React Native's `FormData`
 * treats "an object with a uri attribute" as a file to stream from disk rather
 * than a buffer to serialise. Without the `uri`, a 15 MB photo is copied through
 * JavaScript on its way out.
 */
async function toNativeFile(file: UploadRequest["file"]): Promise<File> {
  const response = await fetch(file.uri);
  const blob = await response.blob();
  const nativeFile = new File([blob], file.name, { type: file.mimeType });
  return Object.assign(nativeFile, { uri: file.uri });
}

export interface UploadThingTransportOptions {
  /** Public site origin, e.g. `https://partybooth.app`. No trailing slash. */
  readonly siteUrl: string;
  /**
   * Native fetch has no browser cookie jar for the website origin. Resolve the
   * Better Auth cookie for every attempt so a refreshed session is not captured
   * when the provider mounts.
   */
  readonly authHeaders?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export function createUploadThingTransport(options: UploadThingTransportOptions): UploadTransport {
  const { uploadFiles } = genUploader<PartyMediaRouter>({
    url: `${options.siteUrl}${UPLOAD_ROUTE_PATH}`,
    // Shows up in the route handler's server logs, so a confusing request can be
    // traced to the app rather than to the website.
    package: "@partybooth/mobile",
  });

  return {
    async upload(request) {
      if (isAborted(request.signal)) throw new UploadCancelledError();

      const file = await toNativeFile(request.file);

      try {
        const [uploaded] = await uploadFiles(UPLOAD_ROUTE_SLUG, {
          files: [file],
          input: request.ticket,
          ...(options.authHeaders === undefined ? {} : { headers: options.authHeaders }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          onUploadProgress: ({ progress }) => {
            // The SDK reports 0–100; the queue works in fractions so the same
            // number can drive a bar, a ring and an accessibility label.
            request.onProgress?.(Math.min(1, Math.max(0, progress / 100)));
          },
        });
        const completion = parseUploadCallbackResult(uploaded?.serverData);
        if (!uploadCallbackSucceeded(completion)) {
          throw new UploadCompletionError(completion.reason);
        }
      } catch (error) {
        // Normalise the SDK's abort error to ours so the queue has exactly one
        // thing to check and never treats a deliberate cancel as a failure.
        if (isUploadCancelled(error)) throw new UploadCancelledError();
        throw error;
      }
    },
  };
}
