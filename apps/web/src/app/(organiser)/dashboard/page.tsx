import type { Metadata } from "next";
import Link from "next/link";

import { EventList } from "@/components/events/event-list";
import { PlusIcon } from "@/components/icons";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Your events" };

/**
 * The organiser's front door: every event they host or co-host.
 *
 * PLAN.md's "Live home" — code/QR, pending count, recent submissions, totals —
 * belongs to a *single* event, and lives at `/events/[eventId]`. This page is
 * the thing above it, and it exists because a host running a wedding and a
 * birthday in the same week needs to be sure which one they are about to
 * archive.
 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Your events"
        description="Open one to see its join code, QR and status."
        actions={
          <Link href="/events/new">
            <Button size="sm">
              <PlusIcon size={16} />
              New event
            </Button>
          </Link>
        }
      />
      <EventList />
    </>
  );
}
