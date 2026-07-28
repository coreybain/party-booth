"use client";

import { useQuery } from "convex/react";
import Link from "next/link";

import { BackendGate } from "@/components/backend-gate";
import { BackendNotConfigured } from "@/components/backend-not-configured";
import { CohostPanel, CohostPanelPlaceholder } from "@/components/events/cohost-panel";
import { RotationPanel, RotationPanelPlaceholder } from "@/components/events/rotation-panel";
import { StateBadge } from "@/components/events/state-badge";
import { Card, Placeholder, SectionHeading } from "@/components/layout/card";
import { Callout } from "@/components/ui/callout";
import { isEditableEventState, isHostRole } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";

/**
 * The co-host and rotation panels, pointed at whichever event is selected.
 *
 * Both are properties of one *event*, and the console already has a way to say
 * which one: the header's event switcher, which writes `users.activeEventId` and
 * which `/media` and `/slideshow` both follow. Adding a third mechanism here —
 * a picker inside the page — would mean two controls on screen that both claim
 * to choose the event, and they would disagree the first time somebody used the
 * wrong one.
 *
 * A **guest** who happens to be signed in gets neither panel. `cohosts.list` and
 * `invites.current` are host-only in Convex (`membership.list`,
 * `event.viewInviteCode`), so rendering them would only produce two thrown
 * queries; saying why is better than letting the error boundary do it.
 */
export function ActiveEventSettings() {
  return (
    <BackendGate fallback={<BackendNotConfigured />}>
      <ActiveEventSettingsLive />
    </BackendGate>
  );
}

function ActiveEventSettingsLive() {
  const active = useQuery(backendApi.events.activeEvent, {});
  const me = useQuery(backendApi.users.currentUser, {});

  if (active === undefined) {
    return (
      <div className="space-y-4" role="status" aria-live="polite">
        <span className="sr-only">Loading your event…</span>
        <div className="h-40 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
        <div className="h-40 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
      </div>
    );
  }

  if (active === null) {
    return (
      <div className="space-y-4">
        <Card>
          <SectionHeading
            title="Co-hosts"
            description="Invite someone to help moderate. They can't delete the event or transfer ownership."
          />
          <CohostPanelPlaceholder className="mt-4" />
        </Card>
        <Card>
          <SectionHeading
            title="Invite rotation"
            description="Issue a new code and QR, and choose whether existing guests keep access."
          />
          <RotationPanelPlaceholder className="mt-4" />
        </Card>
      </div>
    );
  }

  if (!isHostRole(active.role)) {
    return (
      <Card>
        <SectionHeading
          title="Co-hosts & rotation"
          description="Both are host controls."
          action={<StateBadge state={active.state} />}
        />
        <Placeholder className="mt-4" title="You're a guest at this party">
          <Link href={`/event/${active.id}`} className="text-accent underline underline-offset-2">
            Open the guest view
          </Link>{" "}
          instead, or switch to an event you host.
        </Placeholder>
      </Card>
    );
  }

  const editable = isEditableEventState(active.state);

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeading
          title="Co-hosts"
          description="An extra pair of hands on the moderation queue. They can't delete the event or transfer ownership."
          action={<StateBadge state={active.state} />}
        />
        <CohostPanel
          className="mt-4"
          eventId={active.id}
          {...(me?.email === undefined ? {} : { ownEmail: me.email })}
        />
      </Card>

      <Card>
        <SectionHeading
          title="Invite rotation"
          description="A new code and QR, and a choice about the people already in."
        />
        {active.state === "live" ? (
          <Callout tone="warning" className="mt-4">
            This party is live. Rotating now kills the sign on the door immediately — have the new
            QR up on a screen before you do it.
          </Callout>
        ) : null}
        <RotationPanel
          className="mt-4"
          eventId={active.id}
          eventName={active.name}
          canRotate={editable}
        />
      </Card>
    </div>
  );
}
