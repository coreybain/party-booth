"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

import { Card } from "@/components/layout/card";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { appErrorMessage } from "@/lib/app-errors";

/**
 * The boundary for a failing event subscription inside the console.
 *
 * Convex `useQuery` throws during render, so a host who opens a bookmarked
 * event they no longer have access to — or an id that never existed — would
 * otherwise land on the generic app-wide error page. `events.home` answers both
 * with `notFound`, deliberately indistinguishable, and the useful next step is
 * the same either way: back to the list.
 */
export default function EventError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <>
      <PageHeader title="Can't open that event" />
      <Card>
        <p className="text-sm text-muted">{appErrorMessage(error)}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/dashboard">
            <Button>Back to your events</Button>
          </Link>
          <Button variant="ghost" onClick={reset}>
            Try again
          </Button>
        </div>
      </Card>
    </>
  );
}
