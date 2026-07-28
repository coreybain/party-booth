import type { Metadata } from "next";

import { EventSettingsLinks } from "@/components/events/event-settings-links";
import { PageHeader } from "@/components/layout/app-shell";
import { Card, Placeholder, SectionHeading } from "@/components/layout/card";

export const metadata: Metadata = { title: "Settings" };

/**
 * PLAN.md → "Settings: essentials only (schedule, moderation mode, co-host
 * invite, rotation)".
 *
 * Every one of those is a property of an *event*, not of the account, so the
 * schedule and moderation mode live on the event's own edit form and this page
 * points at it for whichever event is selected. Co-hosts and rotation land in
 * Sprint 5 and keep their placeholders, so the shape of the page does not move
 * under the host between now and then.
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Event essentials. Nothing you can break by accident."
      />

      <div className="space-y-4">
        <Card>
          <SectionHeading
            title="Schedule & moderation"
            description="When the event is open, and whether submissions need approving."
          />
          <EventSettingsLinks className="mt-4" />
        </Card>

        <Card>
          <SectionHeading
            title="Co-hosts"
            description="Invite someone to help moderate. They can't delete the event or transfer ownership."
          />
          <Placeholder className="mt-4" title="No co-hosts" sprint="Sprint 5" />
        </Card>

        <Card>
          <SectionHeading
            title="Invite rotation"
            description="Issue a new code and QR, and choose whether existing guests keep access."
          />
          <Placeholder className="mt-4" title="Nothing to rotate" sprint="Sprint 5">
            Rotating kills the printed QR immediately, which is the point — the model and the
            backend mutation are already in place.
          </Placeholder>
        </Card>
      </div>
    </>
  );
}
