import type { Metadata } from "next";

import { EventChooserPage } from "@/components/guest/event-chooser-page";

export const metadata: Metadata = { title: "Choose where to go" };

/** This route depends on the signed-in user's memberships. */
export const dynamic = "force-dynamic";

/** The canonical chooser route; it renders in place and keeps `/events` visible. */
export default async function EventsPage() {
  return <EventChooserPage />;
}
