import type { Metadata } from "next";

import { AccountsTable } from "@/components/admin/accounts-table";
import { AdminConsoleGate } from "@/components/admin/console-gate";
import { PageHeader } from "@/components/layout/app-shell";

export const metadata: Metadata = { title: "Accounts" };

/**
 * PLAN.md → "inspect accounts … lock/unlock, schedule/restore deletion,
 * confirmation + reason + immutable audit on every action".
 */
export default function AdminAccountsPage() {
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Every account in the beta, what it owns, and the four things you can do to it."
      />
      <AdminConsoleGate>
        <AccountsTable />
      </AdminConsoleGate>
    </>
  );
}
