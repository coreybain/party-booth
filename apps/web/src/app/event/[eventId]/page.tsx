import { mobileAppDownloadsEnabled } from "@partybooth/env/client";
import type { Metadata } from "next";

import { GuestEventView } from "@/components/guest/guest-event-view";
import { CentredPane } from "@/components/layout/centred-pane";
import { SiteFooter } from "@/components/layout/site-footer";
import { PARTYBOOTH_APP_STORE_ID, PARTYBOOTH_APP_URL } from "@/lib/mobile-app";

export const metadata: Metadata = {
  title: "Your event",
  robots: { index: false, follow: false },
  ...(mobileAppDownloadsEnabled()
    ? { itunes: { appId: PARTYBOOTH_APP_STORE_ID, appArgument: PARTYBOOTH_APP_URL } }
    : {}),
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
    <CentredPane width="md" footer={<SiteFooter note="Photos stay private to this event." />}>
      <GuestEventView eventId={eventId} />
    </CentredPane>
  );
}
