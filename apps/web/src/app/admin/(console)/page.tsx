import { AdminConsoleGate } from "@/components/admin/console-gate";
import { JobHealthPanel } from "@/components/admin/job-health-panel";
import { PageHeader } from "@/components/layout/app-shell";

/**
 * Global-admin console — the overview.
 *
 * PLAN.md → invite organisers, inspect accounts and events, lock/unlock,
 * schedule/restore deletion, rotate codes, revoke memberships — all with a
 * confirmation, a reason and an immutable audit entry. The two lists and the log
 * are their own routes (see `AdminNav` for why they are routes rather than
 * tabs); the invite action lives beside that navigation in a sheet, while this
 * page holds the job-health panel — the one thing here anybody looks at when
 * nothing is wrong.
 *
 * Explicitly **not** here, now or later: media access and impersonation.
 * `globalAdmin` has no `media.*` capability and no `platform.impersonateUser` in
 * the matrix — those two rows exist in `@partybooth/contracts/permissions`
 * purely so the rule is written down and tested rather than implied.
 */
export default function AdminHomePage() {
  return (
    <>
      <PageHeader
        title="Console"
        description="Invite hosts, inspect accounts and events, and act with an audit trail."
      />

      <div className="space-y-4">
        <AdminConsoleGate>
          <JobHealthPanel />
        </AdminConsoleGate>
      </div>
    </>
  );
}
