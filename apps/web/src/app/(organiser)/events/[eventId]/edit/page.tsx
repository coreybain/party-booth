import type { Metadata } from "next";
import Link from "next/link";

import { EditEvent } from "@/components/events/edit-event";
import { ArrowLeftIcon } from "@/components/icons";
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
      <Link
        href={`/events/${eventId}`}
        className="-ml-2 mb-3 inline-flex h-10 items-center gap-1.5 rounded-xl px-2 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <ArrowLeftIcon size={16} />
        Back to event
      </Link>
      <PageHeader
        title="Edit event"
        description="Changing the schedule or the moderation mode takes effect immediately, mid-party included."
      />
      <EditEvent eventId={eventId} nowMs={serverNow()} />
    </>
  );
}
