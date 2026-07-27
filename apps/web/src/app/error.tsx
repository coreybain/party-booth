"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";

/**
 * Route-level error boundary.
 *
 * `Sentry.captureException` is a no-op when no DSN is configured, so this is
 * safe offline. The digest is shown because it is the only thing that ties what
 * a guest saw on their phone to a server log — and it contains no user data.
 */
export default function RouteError({
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
    <CentredPane>
      <Card>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Something went wrong</h1>
        <p className="mt-1 text-sm text-muted">
          That's on us. Try again — if it keeps happening, tell the host.
        </p>
        <div className="mt-5 flex gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button
            variant="secondary"
            onClick={() => {
              window.location.assign("/");
            }}
          >
            Start over
          </Button>
        </div>
        {error.digest ? (
          <p className="mt-5 text-xs text-faint">
            Reference <Code>{error.digest}</Code>
          </p>
        ) : null}
      </Card>
    </CentredPane>
  );
}
