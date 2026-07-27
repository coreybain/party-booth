/**
 * Sentry — Next.js Node runtime. Loaded by `instrumentation.ts`.
 *
 * No DSN configured → `Sentry.init` is never called, so the SDK stays inert and
 * the app boots normally offline. See `.env.example` → SENTRY_DSN.
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
