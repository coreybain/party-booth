"use client";

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { AuthClient } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import { convexUrl } from "@/lib/backend";

/**
 * One Convex client for the lifetime of the tab.
 *
 * Created at module scope (not in a hook) so that Fast Refresh and route
 * changes never tear down the WebSocket — Convex subscriptions drive the
 * organiser dashboard, gallery and slideshow, and reconnecting on every
 * navigation would make the slideshow flicker.
 *
 * `null` when `NEXT_PUBLIC_CONVEX_URL` is unset: the constructor throws on an
 * empty URL, and the whole app must still render offline.
 */
const convex = convexUrl === undefined ? null : new ConvexReactClient(convexUrl);

/**
 * Client-side providers for the entire app.
 *
 * `ConvexBetterAuthProvider` keeps the Convex client's identity token in sync
 * with the Better Auth session, which is what makes `useQuery` see the signed-in
 * user. With no backend configured it is skipped entirely; children still
 * render, and every screen that needs data shows `<BackendNotConfigured />`.
 *
 * The branch is stable for the lifetime of the module, so React never sees the
 * provider appear or disappear mid-session.
 */
export function Providers({ children }: { readonly children: ReactNode }) {
  if (convex === null) return <>{children}</>;

  return (
    /*
     * The cast is an upstream typing defect, not a shortcut.
     *
     * `@convex-dev/better-auth@0.12.5` declares
     * `AuthClient = ReturnType<typeof createAuthClient<BetterAuthClientPlugin & { plugins: … }>>`.
     * Because the generic is applied to the *options* object, `useSession().data`
     * collapses to `never` in the expected type, and no client produced by
     * `createAuthClient` — including the one in Convex's own Next.js guide — is
     * assignable to it. The runtime contract (a Better Auth client carrying the
     * `convex` plugin) is satisfied.
     *
     * Re-check on every `@convex-dev/better-auth` upgrade; delete when it
     * compiles without help.
     */
    <ConvexBetterAuthProvider client={convex} authClient={authClient as unknown as AuthClient}>
      {children}
    </ConvexBetterAuthProvider>
  );
}
