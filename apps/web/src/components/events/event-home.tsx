"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect } from "react";

import { BackendGate } from "@/components/backend-gate";
import { BackendNotConfigured } from "@/components/backend-not-configured";
import { EventStateControl } from "@/components/events/event-state-control";
import { EventStats } from "@/components/events/event-stats";
import { InvitePanel } from "@/components/events/invite-panel";
import { StateBadge } from "@/components/events/state-badge";
import { UsersIcon } from "@/components/icons";
import { PageHeader } from "@/components/layout/app-shell";
import { Card, SectionHeading } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { eventStatusLine, formatGuestCount } from "@/lib/event-view";

/**
 * The event home: the screen a host has open on their phone all night.
 *
 * PLAN.md's "Live home" is code/QR, status, pending count, recent submissions
 * and totals. Sprint 2 owns the first two; the media panels arrive with the
 * upload spine and are marked as such rather than left blank.
 *
 * Selecting this event also makes it the **active** one, because the app's
 * camera and host tabs follow `users.activeEventId` — opening an event on the
 * laptop and then picking up the phone should not need a second selection.
 */
export function EventHome({
  eventId,
  nowMs,
}: {
  readonly eventId: string;
  readonly nowMs: number;
}) {
  return (
    <BackendGate
      fallback={
        <>
          <PageHeader title="Event" />
          <BackendNotConfigured />
        </>
      }
    >
      <EventHomeLive eventId={eventId} nowMs={nowMs} />
    </BackendGate>
  );
}

function EventHomeLive({ eventId, nowMs }: { readonly eventId: string; readonly nowMs: number }) {
  const home = useQuery(backendApi.events.home, { eventId });
  const setActiveEvent = useMutation(backendApi.events.setActiveEvent);

  // Keyed on `eventId` only — the query result gets a new identity on every
  // subscription tick, and depending on it would re-select the event on each
  // one. `setActiveEvent` re-checks membership, so firing it optimistically
  // before the page has loaded is safe.
  useEffect(() => {
    void setActiveEvent({ eventId }).catch(() => {
      // Cosmetic: a failed selection only means the phone still points at the
      // previous event. Never block the page on it.
    });
  }, [eventId, setActiveEvent]);

  if (home === undefined) return <EventHomeSkeleton />;

  const { event, invite, isHost, memberCount } = home;

  return (
    <>
      <PageHeader
        title={event.name}
        description={eventStatusLine(event, nowMs)}
        actions={
          isHost ? (
            <Link href={`/events/${event.id}/edit`}>
              <Button variant="secondary" size="sm">
                Edit
              </Button>
            </Link>
          ) : undefined
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <StateBadge state={event.state} />
        <span>
          {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
          <span className="text-faint">
            ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <UsersIcon size={16} className="text-faint" />
          {formatGuestCount(memberCount)}
        </span>
      </div>

      <div className="space-y-4">
        <Card>
          <SectionHeading
            title="Join code & QR"
            description="Hold this up, or print it. Both work from the moment the event is scheduled."
          />
          <div className="mt-4">
            {invite === undefined ? (
              <Callout tone="info">
                Only the host and co-hosts can see the join code. Ask them to show you the QR.
              </Callout>
            ) : (
              <InvitePanel
                code={invite.code}
                token={invite.token}
                version={invite.version}
                state={event.state}
                eventName={event.name}
              />
            )}
          </div>
        </Card>

        {isHost ? (
          <Card>
            <SectionHeading
              title="Status"
              description="Guests can join while the event is scheduled, live or paused. Uploads need it live."
            />
            <div className="mt-4">
              <EventStateControl eventId={event.id} state={event.state} />
            </div>
          </Card>
        ) : null}

        {/*
          Sprint 4 replaces the two placeholders that stood here with the real
          numbers. Guests reaching an event page they host see them too — the
          queries are permission-checked in Convex, and `event.viewStats` is a
          host power, so a plain guest never gets this far down the page.
        */}
        {isHost ? <EventStats eventId={event.id} isHost={isHost} /> : null}
      </div>
    </>
  );
}

function EventHomeSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading the event…</span>
      <div className="h-8 w-1/2 animate-pulse rounded-lg bg-raised" aria-hidden="true" />
      <div className="h-4 w-2/3 animate-pulse rounded-lg bg-raised" aria-hidden="true" />
      <div className="h-64 w-full animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
    </div>
  );
}
