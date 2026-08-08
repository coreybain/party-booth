import "server-only";

import { redirect } from "next/navigation";

import { EventChooser } from "@/components/guest/event-chooser";
import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { SiteFooter } from "@/components/layout/site-footer";
import { getOrganiserAccess } from "@/lib/auth-server";

/** The shared signed-in event-or-dashboard chooser used by `/event` and `/events`. */
export async function EventChooserPage() {
  const access = await getOrganiserAccess();
  if (access === "signedOut") redirect("/join");
  if (access !== "ok" && access !== "needsInvitation") redirect("/account/blocked");

  return (
    <CentredPane width="md" footer={<SiteFooter note="Choose where you want to go." />}>
      <Card>
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Where are you headed?</h1>
          <p className="mt-2 text-sm text-muted">
            Open an event to join the party, or go to the admin dashboard to manage the events you
            host.
          </p>
        </div>

        <EventChooser showAdminDashboard={access === "ok"} />
      </Card>
    </CentredPane>
  );
}
