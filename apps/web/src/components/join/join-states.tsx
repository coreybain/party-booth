"use client";

import Link from "next/link";

import { Callout } from "@/components/ui/callout";
import { StoreBadges } from "@/components/join/store-badges";
import { cn } from "@/lib/cn";
import { formatCooldown } from "@/lib/otp";

/**
 * The states the join path can be in that are not "here is the party".
 *
 * They live together because they have to *read* together: the single most
 * important property of this screen is that a guest who mistyped a digit and a
 * guest holding last month's poster see the same words, and that is much easier
 * to keep true when the words are in one file.
 */

/** A quiet skeleton while the preview query is in flight. */
export function JoinLoading({ className }: { readonly className?: string }) {
  return (
    <div className={cn("space-y-3", className)} role="status" aria-live="polite">
      <span className="sr-only">Checking your invitation…</span>
      <div className="h-6 w-3/5 animate-pulse rounded-lg bg-raised" aria-hidden="true" />
      <div className="h-4 w-2/5 animate-pulse rounded-lg bg-raised" aria-hidden="true" />
      <div className="mt-6 h-12 w-full animate-pulse rounded-xl bg-raised" aria-hidden="true" />
    </div>
  );
}

/**
 * Every refusal, in one component.
 *
 * `message` comes from the backend, which returns **one** string for
 * "no such code", "superseded version", "not joinable yet" and "membership
 * revoked" alike (`JOIN_REJECTED_MESSAGE`). Nothing here may branch on it, or
 * the enumeration protection the whole join flow is built around is gone.
 */
export function JoinRejected({
  message,
  showCodeEntry = true,
}: {
  readonly message: string;
  readonly showCodeEntry?: boolean;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">That invite isn't working</h1>
        <p className="mt-1 text-sm text-muted">{message}</p>
      </div>

      <Callout tone="info">
        <p className="text-ink">Two things usually fix it:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>The host may have issued a new code — ask them to show you the current QR.</li>
          <li>Scan the code on the sign again rather than reusing an old photo of it.</li>
        </ul>
      </Callout>

      {showCodeEntry ? (
        <p className="text-center text-sm text-muted">
          <Link href="/join" className="text-accent underline underline-offset-2">
            Type the six-digit code instead
          </Link>
        </p>
      ) : null}

      <StoreBadges />
    </div>
  );
}

/**
 * Rate limited.
 *
 * Unlike a rejection this one *is* safe to be specific about: it depends only
 * on the caller's own attempt history, which is not information they lack. A
 * guest who has genuinely mistyped ten times needs to know that waiting works.
 */
export function JoinThrottled({
  message,
  retryAfterMs,
}: {
  readonly message: string;
  readonly retryAfterMs: number;
}) {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight text-ink">Hold on a moment</h1>
      <Callout tone="warning" live="assertive">
        <p>{message}</p>
        {seconds > 0 ? (
          <p className="mt-1 tabular-nums text-muted">
            Try again in about {formatCooldown(seconds)}.
          </p>
        ) : null}
      </Callout>
      <p className="text-sm text-muted">
        If you are sure of the code, ask the host to check it on their screen — they can see the
        current one at any time.
      </p>
    </div>
  );
}
