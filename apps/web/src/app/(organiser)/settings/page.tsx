import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/app-shell";
import { Card, Placeholder, SectionHeading } from "@/components/layout/card";

export const metadata: Metadata = { title: "Settings" };

/** PLAN.md → "Settings: essentials only (schedule, moderation mode, co-host invite, rotation)". */
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
          <Placeholder className="mt-4" title="No event yet" sprint="Sprint 2" />
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
          <Placeholder className="mt-4" title="Nothing to rotate" sprint="Sprint 5" />
        </Card>
      </div>
    </>
  );
}
