import { createRouteHandler } from "uploadthing/next";

import { partyBoothFileRouter } from "./core";
import {
  isUploadConfigured,
  uploadCallbackUrl,
  uploadServerStatus,
  uploadThingToken,
} from "@/lib/upload/server";

/**
 * `GET|POST /api/uploadthing` — the endpoint the guest capture page uploads to,
 * and the endpoint UploadThing calls back on when a file has landed.
 *
 * Both halves are the same route by design: the `GET` serves the route config
 * the client SDK reads, the `POST` handles the presign request *and* the
 * signed provider callback, told apart by an `uploadthing-hook` header that the
 * handler verifies against the app token. That verification is the reason this
 * file has no signature checking of its own — rolling our own would be a second,
 * weaker implementation of something the SDK already does correctly.
 *
 * With no credentials the route answers **503 with the variable names**, exactly
 * as `/api/auth/*` does. `apps/web` has to build and boot with an empty
 * environment (CONTRIBUTING → "CI has no secrets"), and a route that throws at
 * module scope takes the whole build with it.
 */

/** Session cookies and a provider callback: never static, never cached. */
export const dynamic = "force-dynamic";

/**
 * Node, not Edge. The handler reads the session cookie through
 * `@convex-dev/better-auth`, and `next build` has to be able to trace it — the
 * repo pins `vercel.json` to `iad1` to sit beside the Convex US East deployment
 * for the same reason. Edge would move the grant check further from Convex, not
 * closer to the guest.
 */
export const runtime = "nodejs";

function unavailable(): Response {
  const status = uploadServerStatus();
  return Response.json(
    {
      error: "upload_not_configured",
      message:
        `Uploads are unavailable: ${status.missing.join(", ")} ` +
        "not set. Run `pnpm env:doctor` for where each value comes from.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

const handlers = isUploadConfigured
  ? createRouteHandler({
      router: partyBoothFileRouter,
      config: {
        // Passed explicitly rather than left to the SDK's own `process.env`
        // read: configuration in this repo comes from `@partybooth/env`, which
        // is what makes "which variable is missing?" answerable.
        token: uploadThingToken(),
        ...(uploadCallbackUrl() === undefined ? {} : { callbackUrl: uploadCallbackUrl() }),
      },
    })
  : { GET: unavailable, POST: unavailable };

export const GET = handlers.GET;
export const POST = handlers.POST;
