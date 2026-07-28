"use client";

import type { ReactNode } from "react";

import { BackendGate } from "@/components/backend-gate";
import { Card } from "@/components/layout/card";
import { Placeholder } from "@/components/layout/card";

/**
 * `BackendGate` with the admin console's own empty state.
 *
 * Every page in `/admin` is one or more Convex subscriptions, and
 * `ConvexBetterAuthProvider` is not mounted at all when there is no deployment
 * URL — so the components must never be *rendered*, not merely early-returned.
 * See `BackendGate` for why an early `return` inside the component does not
 * help. This wrapper exists so all four pages say the same thing when there is
 * nothing behind them, which is also what lets the empty-environment
 * `next build` prerender them.
 */
export function AdminConsoleGate({ children }: { readonly children: ReactNode }) {
  return (
    <BackendGate
      fallback={
        <Card>
          <Placeholder title="No deployment configured">
            The console reads live data and there is no Convex deployment on this build. Set{" "}
            <code className="text-code">NEXT_PUBLIC_CONVEX_URL</code> and{" "}
            <code className="text-code">CONVEX_URL</code>, and put your address in{" "}
            <code className="text-code">ADMIN_EMAIL_ALLOWLIST</code>.
          </Placeholder>
        </Card>
      }
    >
      {children}
    </BackendGate>
  );
}
