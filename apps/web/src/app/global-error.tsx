"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import "./globals.css";

/**
 * Last-resort boundary: replaces the root layout, so it has to render its own
 * `<html>` and cannot rely on any provider or shared component.
 */
export default function GlobalError({ error }: { readonly error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en-GB">
      <body className="antialiased">
        <div className="flex min-h-dvh items-center justify-center px-5">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center">
            <h1 className="text-lg font-semibold text-ink">PartyBooth is having a moment</h1>
            <p className="mt-2 text-sm text-muted">
              Reload the page. If it keeps happening, tell the host.
            </p>
            <a
              href="/"
              className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-on-accent"
            >
              Reload
            </a>
            {error.digest ? (
              <p className="mt-5 text-xs text-faint">Reference {error.digest}</p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}
