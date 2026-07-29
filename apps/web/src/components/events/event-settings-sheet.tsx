"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";

import { CohostPanel } from "@/components/events/cohost-panel";
import { RotationPanel } from "@/components/events/rotation-panel";
import { StateBadge } from "@/components/events/state-badge";
import { SectionHeading } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { backendApi, type EventSummary } from "@/lib/convex-api";
import { isEditableEventState } from "@/lib/contracts";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { MODERATION_MODE_COPY } from "@/lib/event-view";

/**
 * Event-specific settings beside the event's lifecycle actions.
 *
 * The event page already has an exact event in hand, so this sheet receives it
 * directly instead of following the global active-event selection. That keeps
 * its schedule, co-host roster and invite code pinned to the title behind it,
 * even if another tab changes the active event while the sheet is open.
 */
export function EventSettingsSheet({
  event,
  open,
  onOpenChange,
}: {
  readonly event: EventSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-xl" closeLabel="Close event settings">
        <SheetHeader>
          <SheetTitle>{event.name} settings</SheetTitle>
          <SheetDescription>
            Manage this event’s schedule, moderation, co-hosts and invitation access.
          </SheetDescription>
        </SheetHeader>

        <EventSettingsBody
          event={event}
          onRequestClose={() => {
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function EventSettingsBody({
  event,
  onRequestClose,
}: {
  readonly event: EventSummary;
  readonly onRequestClose: () => void;
}) {
  const router = useRouter();
  const me = useQuery(backendApi.users.currentUser, {});
  const editable = isEditableEventState(event.state);
  const moderationCopy =
    MODERATION_MODE_COPY[event.moderationMode === "automatic" ? "automatic" : "manual"];

  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-2xl border border-line bg-canvas/35 p-4">
        <SectionHeading
          title="Schedule & moderation"
          description="When guests can join and whether submissions need approval."
          action={<StateBadge state={event.state} />}
        />
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-ink">
              {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
              <span className="text-faint">
                ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
              </span>
            </p>
            <p className="text-sm text-muted">{moderationCopy.label}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!editable}
            onClick={() => {
              onRequestClose();
              router.push(`/events/${event.id}/edit`);
            }}
          >
            Edit event
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-canvas/35 p-4">
        <SectionHeading
          title="Co-hosts"
          description="Invite someone to help moderate and run the slideshow."
        />
        <CohostPanel
          className="mt-4"
          eventId={event.id}
          {...(me?.email === undefined ? {} : { ownEmail: me.email })}
        />
      </section>

      <section className="rounded-2xl border border-line bg-canvas/35 p-4">
        <SectionHeading
          title="Invite rotation"
          description="Replace the join code and choose what happens to existing guests."
        />
        {event.state === "live" ? (
          <Callout tone="warning" className="mt-4">
            This event is live. Have the new QR ready before rotating the code on the door.
          </Callout>
        ) : null}
        <RotationPanel
          className="mt-4"
          eventId={event.id}
          eventName={event.name}
          canRotate={editable}
        />
      </section>
    </div>
  );
}
