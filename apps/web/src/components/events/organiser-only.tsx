"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { Card } from "@/components/layout/card";
import { Placeholder } from "@/components/layout/card";
import { backendApi } from "@/lib/convex-api";

/**
 * Creating events is an **organiser** power; being in the console is not.
 *
 * Sprint 5 opened the organiser shell to co-hosts, which it had to — a co-host
 * who cannot reach `/media` cannot moderate, and that is the whole of RC5. But
 * `platform.createEvent` is gated on `users.isOrganiser` for ordinary accounts
 * (global admins are exempt), and accepting a co-host invitation deliberately
 * does not set it: PLAN.md makes the private beta invitation-only, and a host
 * being able to mint organisers by adding co-hosts would be a way around that.
 *
 * So the two now come apart, and the console has to stop offering a control the
 * backend refuses. This wrapper is that check, in the two places it matters —
 * the dashboard's "New event" button and the create form itself, because the
 * second is reachable by URL whether or not the first is on screen.
 *
 * It reads `users.currentUser`, whose `isOrganiser` the backend recomputes; it
 * is an affordance check and not a boundary. `events.create` calls
 * `requirePermission` regardless.
 */
export function OrganiserOnly({
  children,
  fallback,
}: {
  readonly children: ReactNode;
  /** Rendered for a signed-in account that is not an organiser. */
  readonly fallback?: ReactNode;
}) {
  return (
    <AuthenticatedBackendGate
      fallback={children}
      loadingFallback={null}
      signedOutFallback={fallback ?? null}
    >
      <OrganiserOnlyLive fallback={fallback}>{children}</OrganiserOnlyLive>
    </AuthenticatedBackendGate>
  );
}

function OrganiserOnlyLive({
  children,
  fallback,
}: {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}) {
  const me = useQuery(backendApi.users.currentUser, {});

  // Unresolved: render nothing rather than flashing the control and taking it
  // away, or flashing the refusal at somebody who turns out to be an organiser.
  if (me === undefined) return null;
  // `null` is a signed-out session. The shell has already refused that, so it is
  // a race with sign-out rather than a state worth explaining.
  if (me !== null && (me.isOrganiser || me.isGlobalAdmin)) return <>{children}</>;
  return <>{fallback ?? null}</>;
}

/** The create form's refusal: an explanation, not a disabled form. */
export function NeedsOrganiserInvitation() {
  return (
    <Card>
      <Placeholder title="Creating events needs an organiser invitation">
        You are here as a co-host, which lets you moderate, run the slideshow and change a
        party&rsquo;s settings — but starting a party of your own is invitation-only while
        PartyBooth is in private beta. Ask whoever invited you.{" "}
        <Link href="/dashboard" className="text-accent underline underline-offset-2">
          Back to your events
        </Link>
      </Placeholder>
    </Card>
  );
}
