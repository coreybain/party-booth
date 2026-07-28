"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { Button } from "@/components/ui/button";
import { appErrorMessage, isSignedOutError } from "@/lib/app-errors";

/**
 * The boundary for a failing `events.home` subscription.
 *
 * Convex `useQuery` throws during render, so a guest who opens a link to an
 * event they were removed from — or whose membership a rotation revoked — would
 * otherwise get the generic app-wide error page. The backend answers that case
 * with `notFound`, deliberately indistinguishable from "no such event", and
 * this turns it into the one useful next step: get a fresh code from the host.
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

  const signedOut = isSignedOutError(error);

  return (
    <CentredPane width="md">
      <Card>
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          {signedOut ? "You've been signed out" : "This event isn't open to you"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {signedOut
            ? "Sign in again with the code from the sign."
            : appErrorMessage(error) +
              " The host may have issued a new code — ask them to show you the current QR."}
        </p>

        <div className="mt-5 space-y-2">
          <Link href="/join" className="block">
            <Button size="lg" fullWidth>
              Join with a code
            </Button>
          </Link>
          <Button variant="ghost" size="sm" fullWidth onClick={reset}>
            Try again
          </Button>
        </div>
      </Card>
    </CentredPane>
  );
}
