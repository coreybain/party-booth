"use client";

import { useConvexAuth, useQuery } from "convex/react";
import type { ReactNode } from "react";

import { BackendNotConfigured } from "@/components/backend-not-configured";
import { isBackendConfigured } from "@/lib/backend";
import { backendApi } from "@/lib/convex-api";

export interface BackendGateProps {
  readonly children: ReactNode;
  /** What to show instead. Defaults to the "set NEXT_PUBLIC_CONVEX_URL" panel. */
  readonly fallback?: ReactNode;
}

/**
 * Renders its children only when there is a Convex deployment to talk to.
 *
 * This is a **structural** requirement, not a nicety. `Providers` cannot mount
 * `ConvexBetterAuthProvider` without a deployment URL — `ConvexReactClient`
 * throws on an empty one — so with no backend there is no provider in the tree,
 * and `useQuery` / `useMutation` / `useConvexAuth` throw
 * "Could not find `ConvexProviderWithAuth` as an ancestor". An early `return`
 * inside the component does not help: the hooks have already run by then.
 *
 * Wrapping instead means the hook-using component is never *rendered*, which is
 * the only thing that actually prevents the call. It is also what lets
 * `next build` prerender these routes with an empty environment, which is how
 * the whole app stays browsable offline (README → "Nothing needs live
 * credentials").
 */
export function BackendGate({ children, fallback }: BackendGateProps) {
  if (!isBackendConfigured) return <>{fallback ?? <BackendNotConfigured />}</>;
  return <>{children}</>;
}

export interface AuthenticatedBackendGateProps extends BackendGateProps {
  /** Shown while the Convex provider is installing the browser's identity token. */
  readonly loadingFallback?: ReactNode;
  /** Shown if the browser session has genuinely ended. */
  readonly signedOutFallback?: ReactNode;
}

/**
 * Structural boundary for authenticated Convex reads.
 *
 * A Server Component can confirm the Better Auth cookie before rendering a
 * protected route, while the browser's Convex provider still needs a moment to
 * exchange that session for a Convex identity token. The Better Auth adapter's
 * `isAuthenticated` flag becomes true as soon as the browser session exists,
 * which can be before Convex has installed that token. `users.currentUser` is
 * deliberately safe while signed out, so it acts as the backend handshake:
 * protected children stay unmounted until Convex itself can resolve the user.
 */
export function AuthenticatedBackendGate({
  children,
  fallback,
  loadingFallback,
  signedOutFallback,
}: AuthenticatedBackendGateProps) {
  return (
    <BackendGate fallback={fallback}>
      <ConvexAuthGate loadingFallback={loadingFallback} signedOutFallback={signedOutFallback}>
        {children}
      </ConvexAuthGate>
    </BackendGate>
  );
}

function ConvexAuthGate({
  children,
  loadingFallback,
  signedOutFallback,
}: {
  readonly children: ReactNode;
  readonly loadingFallback?: ReactNode;
  readonly signedOutFallback?: ReactNode;
}) {
  const convexAuth = useConvexAuth();
  const currentUser = useQuery(backendApi.users.currentUser, {});

  if (convexAuth.isLoading || (convexAuth.isAuthenticated && currentUser == null)) {
    return (
      <>
        {loadingFallback !== undefined ? (
          loadingFallback
        ) : (
          <p className="text-sm text-muted" role="status">
            Connecting to your account…
          </p>
        )}
      </>
    );
  }

  if (!convexAuth.isAuthenticated) {
    return (
      <>
        {signedOutFallback !== undefined ? (
          signedOutFallback
        ) : (
          <div className="rounded-xl border border-warning/35 bg-warning/8 px-4 py-3 text-sm text-warning">
            Your session has ended.{" "}
            <a href="/host" className="underline underline-offset-2">
              Sign in again
            </a>
            .
          </div>
        )}
      </>
    );
  }

  return <>{children}</>;
}
