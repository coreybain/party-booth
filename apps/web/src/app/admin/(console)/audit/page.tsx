import type { Metadata } from "next";

import { AdminConsoleGate } from "@/components/admin/console-gate";
import { AuditLogViewer } from "@/components/admin/audit-log-viewer";
import { PageHeader } from "@/components/layout/app-shell";

export const metadata: Metadata = { title: "Audit log" };

/**
 * The append-only record. Read-only by construction — there is no mutation
 * anywhere in `AuditLogViewer`, and there never will be.
 */
export default function AdminAuditPage() {
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, and why they said they were doing it. Nothing here can be edited or removed."
      />
      <AdminConsoleGate>
        <AuditLogViewer />
      </AdminConsoleGate>
    </>
  );
}
