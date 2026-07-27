/**
 * Sentry wiring for apps/mobile — config only, no instrumentation beyond init.
 *
 * Three separate pieces have to agree, and each degrades independently:
 *
 *   1. `app.config.ts` applies `withSentry(...)` only when SENTRY_ORG + SENTRY_PROJECT
 *      are set, so an unconfigured checkout never gets the source-map upload build step.
 *   2. `metro.config.js` always uses `getSentryExpoConfig`, which is harmless without a
 *      DSN — it just emits source maps nobody uploads.
 *   3. This module calls `Sentry.init` only when a DSN is present.
 *
 * Scrubbing mirrors PLAN.md ("Sentry with scrubbing as originally specified"): tokens,
 * emails and signed URLs must never leave the device.
 */

import * as Sentry from "@sentry/react-native";

import { scrubBreadcrumb, scrubEvent, scrubValue } from "./scrub";

let initialised = false;

/**
 * Initialise Sentry if a DSN was provided.
 *
 * @returns `true` when reporting is live, `false` when it is a deliberate no-op.
 */
export function initSentry(options: {
  readonly dsn: string | undefined;
  readonly environment?: string;
  readonly release?: string;
}): boolean {
  if (initialised) return true;
  if (!options.dsn) return false;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment ?? (__DEV__ ? "development" : "production"),
    ...(options.release ? { release: options.release } : {}),
    // PLAN.md forbids retaining personal data we do not need; PII stays off.
    sendDefaultPii: false,
    // Sprint 1 keeps tracing off — it is noise until there are real user journeys,
    // and it costs quota. Revisit alongside the upload pipeline in Sprint 3.
    tracesSampleRate: 0,
    enableAutoSessionTracking: true,
    // The whole event graph is walked, not just `request.url` / `user` /
    // `exception.values[].value`: `extra`, `contexts`, `tags` and `breadcrumbs`
    // are exactly where a caller-supplied object smuggles a token out.
    // `scrubEvent` also reduces `user` to an opaque id.
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  });

  initialised = true;
  return true;
}

/** True once {@link initSentry} has actually started the SDK. */
export function isSentryEnabled(): boolean {
  return initialised;
}

/**
 * Report a handled error. A no-op when Sentry is not configured, so call sites never
 * need to check first.
 */
export function captureHandledError(error: unknown, context?: Record<string, unknown>): void {
  if (!initialised) {
    if (__DEV__) console.warn("[sentry disabled]", error, context);
    return;
  }
  // Scrubbed here as well as in `beforeSend`: callers pass arbitrary objects,
  // and belt-and-braces costs nothing on a handled-error path.
  const extra = context ? (scrubValue(context) as Record<string, unknown>) : undefined;
  Sentry.captureException(error, extra ? { extra } : undefined);
}

export { Sentry };
