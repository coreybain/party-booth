"use client";

import { useQuery } from "convex/react";
import Link from "next/link";

import { BackendGate } from "@/components/backend-gate";
import { BackendNotConfigured } from "@/components/backend-not-configured";
import { StateBadge } from "@/components/events/state-badge";
import { Placeholder } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule } from "@/lib/datetime";
import { isEditableEventState } from "@/lib/contracts";
import { MODERATION_MODE_COPY } from "@/lib/event-view";

/**
 * One row per event, each linking to that event's settings.
 *
 * Schedule and moderation mode are event properties, so "Settings" without an
 * event chosen is meaningless. Rather than invent an account-level settings
 * page that has nothing on it, this lists what there is.
 */
export function EventSettingsLinks({ className }: { readonly className?: string }) {
  return (
    <BackendGate fallback={<BackendNotConfigured className={className} />}>
      <EventSettingsLinksLive className={className} />
    </BackendGate>
  );
}

function EventSettingsLinksLive({ className }: { readonly className?: string }) {
  const events = useQuery(backendApi.events.myEvents, {});

  if (events === undefined) {
    return (
      <div className={className} role="status" aria-live="polite">
        <span className="sr-only">Loading your events…</span>
        <div className="h-16 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <Placeholder className={className} title="No event yet">
        <Link href="/events/new" className="text-accent underline underline-offset-2">
          Create one
        </Link>{" "}
        and its schedule and moderation settings appear here.
      </Placeholder>
    );
  }

  return (
    <ul className={className}>
      {events.map((event) => (
        <li
          key={event.id}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-0"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">{event.name}</span>
              <StateBadge state={event.state} />
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {formatSchedule(event.startsAt, event.endsAt, event.timeZone)} ·{" "}
              {event.moderationMode === "automatic"
                ? MODERATION_MODE_COPY.automatic.label
                : MODERATION_MODE_COPY.manual.label}
            </p>
          </div>
          <Link href={`/events/${event.id}/edit`}>
            <Button variant="secondary" size="sm" disabled={!isEditableEventState(event.state)}>
              Edit
            </Button>
          </Link>
        </li>
      ))}
    </ul>
  );
}
