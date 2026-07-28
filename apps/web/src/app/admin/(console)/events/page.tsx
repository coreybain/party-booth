import type { Metadata } from "next";

import { AdminConsoleGate } from "@/components/admin/console-gate";
import { EventsTable } from "@/components/admin/events-table";
import { PageHeader } from "@/components/layout/app-shell";

export const metadata: Metadata = { title: "Events" };

/**
 * PLAN.md → "inspect … events/asset counts/storage … rotate codes (random or
 * collision-checked specific), revoke memberships".
 */
export default function AdminEventsPage() {
  return (
    <>
      <PageHeader
        title="Events"
        description="Every party, what it holds, and who is in it. Counts and names — never a photograph."
      />
      <AdminConsoleGate>
        <EventsTable />
      </AdminConsoleGate>
    </>
  );
}
