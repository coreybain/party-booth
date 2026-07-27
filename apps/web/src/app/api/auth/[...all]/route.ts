import { authRouteHandler } from "@/lib/auth-server";

/**
 * Better Auth endpoint.
 *
 * `@convex-dev/better-auth/nextjs` proxies these requests to the Better Auth
 * handler mounted on Convex HTTP actions (`CONVEX_SITE_URL`). Going via this
 * app rather than talking to `*.convex.site` directly is what makes the session
 * cookie *first-party* — decisive on iOS Safari, which is the browser most
 * guests will use at the party and which blocks third-party cookies outright.
 *
 * Returns 503 with an actionable message when Convex is not configured.
 */

/** Sessions must never be cached, and the Node runtime is required for cookies. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = authRouteHandler;
