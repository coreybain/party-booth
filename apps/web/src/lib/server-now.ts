import "server-only";

/**
 * "Now", read once while a Server Component renders, and passed down as a prop.
 *
 * Two rules meet here and only one of them applies:
 *
 * - A **client** component's render must be pure, so `Date.now()` in one is a
 *   real bug: React may re-render it at any time, the server and the hydration
 *   pass would disagree, and `react-hooks/purity` is right to refuse it.
 * - A **Server** Component renders once per request and never re-renders, so
 *   reading the clock there is exactly as deterministic as reading a header.
 *   Every organiser route is `dynamic = "force-dynamic"`, so the value is
 *   request-fresh rather than baked into a build.
 *
 * Keeping the call behind this seam — with `server-only` to enforce where it
 * may be used — is what lets the components downstream take a plain `nowMs`
 * prop and stay pure, instead of every page carrying a lint suppression.
 */
export function serverNow(): number {
  return Date.now();
}
