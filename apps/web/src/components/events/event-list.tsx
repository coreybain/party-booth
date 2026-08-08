"use client";

import { useQuery } from "convex/react";
import Link from "next/link";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { StateBadge } from "@/components/events/state-badge";
import { ArrowRightIcon, PlusIcon } from "@/components/icons";
import { Card } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { backendApi, type EventSummary } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { organiserEvents } from "@/lib/organiser-events";

/**
 * Every event this account owns or co-hosts, newest first.
 *
 * `myEvents` also includes ordinary QR-code guest memberships for the event
 * chooser. The organiser dashboard must filter those out: being able to attend
 * a party does not make it one the user administers.
 */
export function EventList() {
  return (
    <AuthenticatedBackendGate>
      <EventListLive />
    </AuthenticatedBackendGate>
  );
}

function EventListLive() {
  const memberships = useQuery(backendApi.events.myEvents, {});

  if (memberships === undefined) return <EventListSkeleton />;
  const events = organiserEvents(memberships);
  if (events.length === 0) return <NoEvents />;

  return (
    <ul className="space-y-3">
      {events.map((event) => (
        <li key={event.id}>
          <EventRow event={event} />
        </li>
      ))}
    </ul>
  );
}

function EventRow({ event }: { readonly event: EventSummary }) {
  return (
    <Link
      href={`/events/${event.id}`}
      className="block rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-1 h-10 w-1.5 shrink-0 rounded-full bg-accent"
          style={
            event.accentColor === undefined ? undefined : { backgroundColor: event.accentColor }
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-ink">{event.name}</h2>
            <StateBadge state={event.state} />
            {event.role === "cohost" ? (
              <span className="rounded-full border border-line px-2 py-0.5 text-xs text-faint">
                Co-host
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
            <span className="text-faint">
              ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
            </span>
          </p>
          {event.counts.total > 0 ? (
            <p className="mt-1 text-sm text-faint">
              {String(event.counts.total)} submitted · {String(event.counts.pending)} waiting on you
            </p>
          ) : null}
        </div>
        <ArrowRightIcon size={18} className="mt-1 shrink-0 text-faint" />
      </div>
    </Link>
  );
}

function NoEvents() {
  return (
    <Card className="text-center">
      <h2 className="text-base font-semibold text-ink">No events yet</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
        Creating one gives you a six-digit code and a QR code straight away, so you can print the
        sign long before the day.
      </p>
      <div className="mt-5 flex justify-center">
        <Link href="/events/new">
          <Button size="lg">
            <PlusIcon size={18} />
            Create an event
          </Button>
        </Link>
      </div>
    </Card>
  );
}

function EventListSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <span className="sr-only">Loading your events…</span>
      {[0, 1].map((key) => (
        <div key={key} className="h-24 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
      ))}
    </div>
  );
}
