import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { getOrganiserAccess, isServerBackendConfigured } from "@/lib/auth-server";
import { BLOCKED_ACCOUNT_COPY } from "@/lib/lock-view";

export const metadata: Metadata = {
  title: "Account suspended",
  robots: { index: false, follow: false },
};

/**
 * Where a locked, deletion-scheduled or deleted account lands.
 *
 * This route exists because the alternative was worse in two distinct ways.
 * Before it, `/dashboard` bounced a locked organiser to `/?needs=invitation` and
 * `/` bounced any signed-in visitor to `/dashboard` — an infinite redirect, so
 * a locked account could not reach *any* page at all. And even without the loop,
 * "you need an invitation" is the wrong sentence: it is untrue, and it sends
 * somebody off to chase an invitation that would change nothing.
 *
 * This audience is the one entitled to the detail — it is their own account —
 * so the copy says the word, says what it means for the parties they run, and
 * offers the two things that still work. A **guest** at one of those parties is
 * told something quite different and deliberately vaguer; see
 * `unavailableEventView` in `src/lib/lock-view.ts`.
 *
 * Account deletion stays reachable from here on purpose: Apple 5.1.1(v) requires
 * it regardless of standing, and a lock is only appealable if the person can see
 * that they have been locked.
 */

/** Reads the session cookie, so never prerender or cache it. */
export const dynamic = "force-dynamic";
export default async function AccountBlockedPage() {
  // With no Convex deployment there is no session and therefore no lock; the
  // route still has to render for the empty-environment `next build`.
  const access = isServerBackendConfigured ? await getOrganiserAccess() : "locked";

  // An account that is fine has no business on this page, and leaving it
  // reachable would make "am I locked?" answerable by URL rather than by fact.
  if (access === "ok" || access === "needsInvitation") redirect("/dashboard");
  if (access === "signedOut") redirect("/host");

  const copy = BLOCKED_ACCOUNT_COPY[access];

  return (
    <CentredPane width="md">
      <Card>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted">{copy.body}</p>

        <Callout tone="warning" className="mt-4">
          {copy.effect}
        </Callout>

        <div className="mt-6 space-y-2">
          {copy.offerDeletion ? (
            <Link href="/account/deletion" className="block">
              <Button variant="secondary" size="lg" fullWidth>
                Delete my account instead
              </Button>
            </Link>
          ) : null}
          <SignOutButton redirectTo="/" />
        </div>

        <p className="mt-6 text-xs text-faint">
          Every suspension is recorded with a reason. Quoting the address on this account is enough
          for us to find it.
        </p>
      </Card>
    </CentredPane>
  );
}
