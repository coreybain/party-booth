"use client";

/**
 * The browser's uploader, bound to our own FileRouter.
 *
 * `genUploader` is UploadThing's typed client: it reads the route config from
 * `GET /api/uploadthing`, asks the same endpoint to presign, PUTs the bytes
 * straight to storage and reports progress while it does. Written by hand this
 * would be three requests and a retry policy, and the retry policy is the part
 * that matters on party wifi.
 *
 * The router type crosses the server/client boundary as a **type only**, which
 * is erased before any bundler sees it — `core.ts` imports `server-only` and
 * would throw loudly if a value ever escaped from it. What that buys is a
 * compile error rather than a runtime one when the ticket's shape and the
 * middleware's parser drift apart.
 *
 * `url` is passed explicitly. The SDK's default reads `VERCEL_URL` and falls
 * back to `window.location.origin`, and on a preview deployment behind the
 * repo's own domain those are two different origins — a same-origin relative
 * path is both correct and the only version that carries the session cookie.
 */

import { genUploader } from "uploadthing/client";

import type { PartyBoothFileRouter } from "@/app/api/uploadthing/core";

export const UPLOAD_ENDPOINT = "/api/uploadthing";

export const { uploadFiles } = genUploader<PartyBoothFileRouter>({
  url: UPLOAD_ENDPOINT,
  package: "@partybooth/web",
});

/** The one route slug. Named so a typo is a compile error, not a 404. */
export const PARTY_MEDIA_ROUTE = "partyMedia" as const;

/** Private account-avatar route, separately granted from event media. */
export const AVATAR_IMAGE_ROUTE = "avatarImage" as const;
