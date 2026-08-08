"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { cn } from "@/lib/cn";
import { backendApi } from "@/lib/convex-api";

/** Offers a signed-in guest a quick route back to their current event. */
export function EventNotFoundActions() {
  return (
    <AuthenticatedBackendGate
      fallback={<NoEventActions />}
      loadingFallback={<ActionsLoading />}
      signedOutFallback={<NoEventActions />}
    >
      <EventNotFoundActionsLive />
    </AuthenticatedBackendGate>
  );
}

function EventNotFoundActionsLive() {
  const activeEvent = useQuery(backendApi.events.activeEvent, {});

  if (activeEvent === undefined) return <ActionsLoading />;
  if (activeEvent === null) return <NoEventActions />;

  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Your Events</h1>
      <p className="mt-1 text-sm text-muted">Return to your event or join a new one.</p>
      <div className="mt-5 space-y-4">
        <ActionLink href={`/event/${activeEvent.id}`} variant="secondary">
          <span className="truncate">{activeEvent.name}</span>
        </ActionLink>
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs text-faint">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <ActionLink href="/join">Join a new event</ActionLink>
      </div>
    </>
  );
}

function NoEventActions() {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Nothing here</h1>
      <p className="mt-1 text-sm text-muted">
        That link may have expired, or the host may have rotated the event code.
      </p>
      <div className="mt-5">
        <ActionLink href="/join">Join a new event</ActionLink>
      </div>
    </>
  );
}

function ActionLink({
  href,
  children,
  variant = "primary",
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: "primary" | "secondary";
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-12 w-full min-w-0 items-center justify-center gap-2 rounded-xl px-5 text-base font-medium",
        "transition-[filter,background-color,border-color] duration-150",
        variant === "primary"
          ? "bg-accent text-on-accent hover:brightness-110 active:brightness-95"
          : "border border-line bg-raised text-ink hover:border-line-strong",
      )}
    >
      {children}
    </Link>
  );
}

function ActionsLoading() {
  return (
    <div className="space-y-4" role="status">
      <span className="sr-only">Finding your events…</span>
      <div className="h-12 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      <div className="h-12 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      <div className="h-12 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
    </div>
  );
}
