import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/app-shell";
import { Card, Placeholder, SectionHeading } from "@/components/layout/card";

export const metadata: Metadata = { title: "Home" };

/**
 * Organiser home. PLAN.md → "Live home: code/QR, status, pending count, recent
 * submissions, totals" — all of which needs events (Sprint 2) and media
 * (Sprint 3). Sprint 1 ships the empty shell.
 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Home"
        description="Your event at a glance: join code, live status and what's waiting for you."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <SectionHeading title="Join code & QR" description="What guests scan or type." />
          <Placeholder className="mt-4" title="No event yet" sprint="Sprint 2">
            Creating an event generates a six-digit code and a QR that points at{" "}
            <span className="whitespace-nowrap">/join/&lt;token&gt;</span>.
          </Placeholder>
        </Card>

        <Card>
          <SectionHeading title="Pending review" description="Submissions waiting on you." />
          <Placeholder className="mt-4" title="Nothing to moderate" sprint="Sprint 4" />
        </Card>

        <Card className="sm:col-span-2">
          <SectionHeading title="Recent submissions" description="Live, as guests upload." />
          <Placeholder className="mt-4" title="No media yet" sprint="Sprint 3">
            Photos and video appear here within seconds of a guest uploading, over a Convex
            subscription.
          </Placeholder>
        </Card>
      </div>
    </>
  );
}
