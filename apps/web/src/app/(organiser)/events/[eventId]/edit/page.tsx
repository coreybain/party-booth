import type { Metadata } from "next";

import { EditEvent } from "@/components/events/edit-event";
import { PageHeader } from "@/components/layout/app-shell";
import { serverNow } from "@/lib/server-now";

export const metadata: Metadata = { title: "Edit event" };

export default async function EditEventPage({
  params,
}: {
  readonly params: Promise<{ readonly eventId: string }>;
}) {
  const { eventId } = await params;

  return (
    <>
      <PageHeader
        title="Edit event"
        description="Changing the schedule or the moderation mode takes effect immediately, mid-party included."
      />
      <EditEvent eventId={eventId} nowMs={serverNow()} />
    </>
  );
}
