"use client";

import type { ReactNode } from "react";

import { BackendNotConfigured } from "@/components/backend-not-configured";
import { isBackendConfigured } from "@/lib/backend";

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
