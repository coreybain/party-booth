/**
 * Better Auth browser client, wired to the Convex backend.
 *
 * Shape follows the current Convex + Better Auth guide
 * (https://labs.convex.dev/better-auth/framework-guides/next):
 * `createAuthClient` from `better-auth/react` plus the `convexClient()` plugin,
 * which is what lets `ConvexBetterAuthProvider` mint Convex identity tokens
 * from the Better Auth session.
 *
 * Requests go to this Next.js app's own `/api/auth/*` route, which proxies to
 * the Convex HTTP-actions origin (`CONVEX_SITE_URL`). That indirection is what
 * makes the session a first-party cookie — important because iOS Safari, the
 * primary guest browser at the party, drops third-party cookies.
 *
 * Constructing the client never performs a network call, so this module is
 * import-safe even with no backend configured. Calls made through it will fail
 * at request time; the UI checks `isBackendConfigured` before offering them.
 */

import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { AUTH_BASE_PATH } from "./backend";

export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [
    convexClient(),
    // PLAN.md → organisers, admins and web guests all sign in with a six-digit
    // email OTP. Google is added in Sprint 2 (web guests only; Apple is app-only).
    emailOTPClient(),
  ],
});

/** `useSession()` etc., re-exported so components import from one place. */
export const { useSession, signOut } = authClient;
