/**
 * Sentry scrubbing for `apps/web`.
 *
 * The implementation moved to `@partybooth/contracts/scrub` so that the web
 * app, the Expo app and the Convex deployment all apply **one** set of rules —
 * three copies is how a six-digit OTP ends up redacted in one runtime and
 * shipped verbatim from another. This module stays as the app-local name the
 * Sentry config files import, and as the home of the specification test
 * (`sentry-scrub.test.ts`), which now exercises the shared implementation.
 */

export {
  isSensitiveKey,
  REDACTED,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  scrubValue,
} from "@partybooth/contracts/scrub";
