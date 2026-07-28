import type { Metadata } from "next";

import { EventHome } from "@/components/events/event-home";
import { serverNow } from "@/lib/server-now";

export const metadata: Metadata = { title: "Event" };

/**
 * One event's home inside the organiser console: code, QR, status, schedule.
 *
 * The title stays generic because the event's name is not knowable without a
 * Convex read, and the read is the client component's job — a server-side fetch
 * here would only exist to fill in a browser tab.
 */
export default async function EventPage({
  params,
}: {
  readonly params: Promise<{ readonly eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventHome eventId={eventId} nowMs={serverNow()} />;
}
