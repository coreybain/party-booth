/**
 * Sentry — browser. Next.js loads this before any application code.
 *
 * No `NEXT_PUBLIC_SENTRY_DSN` → `Sentry.init` is never called, nothing is sent,
 * and the SDK adds no network traffic. Session Replay is deliberately *not*
 * enabled: replays of a party are exactly the kind of media PLAN.md says never
 * leaves private storage.
 */
import { clientEnv, clientFeatures, clientSentryEnvironment } from "@partybooth/env/client";
import { envOptional } from "@partybooth/env";
import * as Sentry from "@sentry/nextjs";

import { sharedSentryOptions } from "@/lib/sentry-options";

if (clientFeatures.sentry) {
  Sentry.init({
    dsn: envOptional(clientEnv, "NEXT_PUBLIC_SENTRY_DSN"),
    ...sharedSentryOptions({ environment: clientSentryEnvironment() }),
  });
}

/** Instruments App Router navigations. Harmless when Sentry was never started. */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
