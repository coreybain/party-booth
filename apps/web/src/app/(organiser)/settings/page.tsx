import type { Metadata } from "next";

import { ActiveEventSettings } from "@/components/events/active-event-settings";
import { EventSettingsLinks } from "@/components/events/event-settings-links";
import { PageHeader } from "@/components/layout/app-shell";
import { Card, SectionHeading } from "@/components/layout/card";

export const metadata: Metadata = { title: "Settings" };

/**
 * PLAN.md → "Settings: essentials only (schedule, moderation mode, co-host
 * invite, rotation)".
 *
 * Every one of those is a property of an *event*, not of the account. The
 * schedule and the moderation mode live on the event's own edit form, so the
 * first card lists the events and links to it; co-hosts and rotation have
 * nowhere else to be, and they follow the header's event switcher — the same
 * selection `/media` and `/slideshow` read. Adding a second event picker inside
 * this page would put two controls on screen that both claim to choose the
 * event, and they would disagree the first time somebody used the wrong one.
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Event essentials. The co-host and rotation panels act on whichever event is selected above."
      />

      <div className="space-y-4">
        <Card>
          <SectionHeading
            title="Schedule & moderation"
            description="When the event is open, and whether submissions need approving."
          />
          <EventSettingsLinks className="mt-4" />
        </Card>

        <ActiveEventSettings />
      </div>
    </>
  );
}
