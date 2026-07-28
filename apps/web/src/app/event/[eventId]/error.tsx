"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { Button } from "@/components/ui/button";
import { unavailableEventView } from "@/lib/lock-view";

/**
 * The boundary for a failing `events.home` subscription.
 *
 * Convex `useQuery` throws during render, so a guest who opens a link to an
 * event they were removed from — or whose membership a rotation revoked — would
 * otherwise get the generic app-wide error page. The backend answers that case
 * with `notFound`, deliberately indistinguishable from "no such event", and
 * this turns it into the one useful next step: get a fresh code from the host.
 *
 * Sprint 5 added a *third* case, and it needs different words. An event whose
 * owner's account has been locked or scheduled for deletion answers `forbidden`,
 * not `notFound` — and telling thirty guests to "ask the host for the current
 * QR" would be both wrong (a new code changes nothing) and pointed (it sends the
 * room at a host who cannot fix it). `unavailableEventView` picks the framing;
 * the sentence itself comes from the backend, which is already careful to say
 * nothing about whose account it is.
 */
export default function GuestEventError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const view = unavailableEventView(error);

  return (
    <CentredPane width="md">
      <Card>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{view.title}</h1>
        <p className="mt-1 text-sm text-muted">{view.body}</p>

        <div className="mt-5 space-y-2">
          {view.offerRejoin ? (
            <Link href="/join" className="block">
              <Button size="lg" fullWidth>
                Join with a code
              </Button>
            </Link>
          ) : null}
          <Button variant="ghost" size="sm" fullWidth onClick={reset}>
            Try again
          </Button>
        </div>
      </Card>
    </CentredPane>
  );
}
