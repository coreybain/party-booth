/**
 * Redaction helpers for anything leaving the device — today that means Sentry events.
 *
 * The rules themselves live in `@partybooth/contracts/scrub`, shared with `apps/web`
 * and the Convex deployment. They used to be a separate, weaker implementation here:
 * emails and `/join/<token>` paths only, with no JWT, `Bearer`, provider-key,
 * `token=`/`secret=` or standalone six-digit (OTP / join code) rules and no
 * sensitive-key replacement. A breadcrumb carrying a session token or an OTP left the
 * phone intact. One implementation, one set of tests, no drift.
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
