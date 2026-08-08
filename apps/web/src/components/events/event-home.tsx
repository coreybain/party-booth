"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect } from "react";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { BackendNotConfigured } from "@/components/backend-not-configured";
import { EventInviteDialog } from "@/components/events/event-invite-dialog";
import { EventStateControl } from "@/components/events/event-state-control";
import { EventStats } from "@/components/events/event-stats";
import { GuestEventMenu } from "@/components/events/guest-event-menu";
import { GuestManagerSheet } from "@/components/events/guest-manager-sheet";
import { InvitePanel } from "@/components/events/invite-panel";
import { StateBadge } from "@/components/events/state-badge";
import { GuestCapture } from "@/components/guest/guest-event-view";
import { UsersIcon } from "@/components/icons";
import { PageHeader } from "@/components/layout/app-shell";
import { Card, SectionHeading } from "@/components/layout/card";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import {
  eventStatusLine,
  formatGuestCount,
  galleryIsVisible,
  guestsCanUpload,
} from "@/lib/event-view";
import { useNow } from "@/lib/use-now";

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
    <AuthenticatedBackendGate
      fallback={
        <>
          <PageHeader title="Event" />
          <BackendNotConfigured />
        </>
      }
    >
      <EventHomeLive eventId={eventId} nowMs={nowMs} />
    </AuthenticatedBackendGate>
  );
}

function EventHomeLive({ eventId, nowMs }: { readonly eventId: string; readonly nowMs: number }) {
  const tickingNow = useNow();
  const now = tickingNow === 0 ? nowMs : tickingNow;
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
  // Global admins can receive a code for support work but intentionally have
  // no media access. A real guest has neither host powers nor invite details.
  const isGuest = !isHost && invite === undefined;

  return (
    <>
      <PageHeader
        title={event.name}
        description={eventStatusLine(event, now)}
        actions={
          isHost ? (
            <>
              {invite === undefined ? null : (
                <EventInviteDialog
                  code={invite.code}
                  token={invite.token}
                  version={invite.version}
                  state={event.state}
                  eventName={event.name}
                />
              )}
              <EventStateControl
                event={event}
                invite={invite}
                isOwner={event.role === "owner"}
                nowMs={now}
              />
            </>
          ) : isGuest ? (
            <GuestEventMenu eventId={event.id} showGallery={galleryIsVisible(event.state)} />
          ) : undefined
        }
      />

      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        {event.state === "live" ? null : <StateBadge state={event.state} />}
        <span>
          {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
          <span className="text-faint">
            ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
          </span>
        </span>
        {isHost ? (
          <GuestManagerSheet eventId={event.id} memberCount={memberCount} />
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <UsersIcon size={16} className="text-faint" />
            {formatGuestCount(memberCount)}
          </span>
        )}
      </div>

      <div className="space-y-8">
        {isHost && invite !== undefined ? (
          <Card>
            <SectionHeading
              title="Join code & QR"
              description="Hold this up, or print it. Both work from the moment the event is scheduled."
            />
            <div className="mt-4">
              <InvitePanel
                code={invite.code}
                token={invite.token}
                version={invite.version}
                state={event.state}
                eventName={event.name}
              />
            </div>
          </Card>
        ) : null}

        {isGuest ? (
          <GuestCapture
            event={event}
            uploadsOpen={guestsCanUpload(event, now)}
            now={now}
            layout="console"
          />
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
