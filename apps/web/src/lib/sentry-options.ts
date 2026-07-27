/**
 * Shared `Sentry.init` options for the browser, Node and Edge runtimes.
 *
 * Two layers of protection, on purpose:
 *
 * 1. `dataCollection` stops the SDK from *gathering* cookies, query strings,
 *    HTTP bodies, local variables and user info in the first place.
 * 2. `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb` scrub whatever
 *    still made it into the payload (see `sentry-scrub.ts`).
 *
 * Sentry is only ever initialised when a DSN is configured — see the callers in
 * `instrumentation-client.ts`, `sentry.server.config.ts` and
 * `sentry.edge.config.ts`. With no DSN the SDK is never started, so every
 * `Sentry.captureException` in the app becomes a no-op and the app runs
 * completely offline.
 */

import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

/** Headers that must never leave the machine, whatever else is collected. */
const DENIED_REQUEST_HEADERS = [
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-forwarded-for",
  "x-real-ip",
  "x-vercel-forwarded-for",
];

const DENIED_RESPONSE_HEADERS = ["set-cookie"];

/**
 * Options shared by every runtime. Spread this into `Sentry.init` and add the
 * `dsn` plus any runtime-specific integrations.
 */
export function sharedSentryOptions(options: { readonly environment: string }) {
  return {
    environment: options.environment,

    /**
     * Party traffic is bursty and this is a private beta — 10 % is plenty to
     * spot a systemic problem without burning the quota on the night.
     */
    tracesSampleRate: 0.1,

    /** Enough context to debug, few enough to review. */
    maxBreadcrumbs: 30,

    dataCollection: {
      /** Never auto-populate `user.*`; `beforeSend` reduces it to an opaque id. */
      userInfo: false,
      /** Session cookies are bearer credentials. */
      cookies: false,
      /** Signed-URL signatures and join codes live in query strings. */
      urlQueryParams: false,
      /** Request bodies carry OTP codes and email addresses. */
      httpBodies: [],
      /** Locals in a stack frame routinely hold the OTP being verified. */
      stackFrameVariables: false,
      databaseQueryData: false,
      httpHeaders: {
        request: { deny: DENIED_REQUEST_HEADERS },
        response: { deny: DENIED_RESPONSE_HEADERS },
      },
    },

    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
