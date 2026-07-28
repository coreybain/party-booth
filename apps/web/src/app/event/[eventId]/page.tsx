import type { Metadata } from "next";

import { GuestEventView } from "@/components/guest/guest-event-view";
import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";

export const metadata: Metadata = {
  title: "Your event",
  robots: { index: false, follow: false },
};

/**
 * The guest's home for one event, and where every join path lands.
 *
 * Deliberately outside the `(organiser)` route group: that shell is gated on an
 * organiser invitation (private beta), and a guest has none. The gate that
 * applies here is membership, and it is enforced in Convex by `events.home`
 * rather than in a layout — a layout check protects the page and nothing else.
 */
export default async function GuestEventPage({
  params,
}: {
  readonly params: Promise<{ readonly eventId: string }>;
}) {
  const { eventId } = await params;

  return (
    <CentredPane width="md" footer="Private beta · 18+ · Photos stay private to this event.">
      <Card>
        <GuestEventView eventId={eventId} />
      </Card>
    </CentredPane>
  );
}
