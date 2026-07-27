import * as Sentry from "@sentry/nextjs";

/**
 * Next.js server instrumentation hook.
 *
 * `NEXT_RUNTIME` is set by Next.js itself and is not part of
 * `@partybooth/env`'s schema, so it is read from `process.env` directly (the
 * ESLint rule is switched off for this file in `eslint.config.mjs`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Reports errors thrown in Server Components, route handlers and Server
 * Actions. A no-op when `Sentry.init` was never called.
 */
export const onRequestError = Sentry.captureRequestError;
