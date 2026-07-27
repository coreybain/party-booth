/**
 * Sentry — Next.js Edge runtime. Loaded by `instrumentation.ts`.
 *
 * PartyBooth has no Edge routes at the moment; the file exists so that adding
 * one later cannot silently lose error reporting. Same rule as everywhere else:
 * no DSN → no `Sentry.init`.
 */
import { envOptional, sentryEnvironment, serverEnv, serverFeatures } from "@partybooth/env/server";
import * as Sentry from "@sentry/nextjs";

import { sharedSentryOptions } from "@/lib/sentry-options";

if (serverFeatures.sentry) {
  Sentry.init({
    dsn: envOptional(serverEnv, "SENTRY_DSN"),
    ...sharedSentryOptions({ environment: sentryEnvironment() }),
  });
}
