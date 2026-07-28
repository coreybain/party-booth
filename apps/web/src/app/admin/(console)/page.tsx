import Link from "next/link";

import { AdminConsoleGate } from "@/components/admin/console-gate";
import { JobHealthPanel } from "@/components/admin/job-health-panel";
import { OrganiserInviteForm } from "@/components/admin/organiser-invite-form";
import { PageHeader } from "@/components/layout/app-shell";
import { Card, SectionHeading } from "@/components/layout/card";

/**
 * Global-admin console — the overview.
 *
 * PLAN.md → invite organisers, inspect accounts and events, lock/unlock,
 * schedule/restore deletion, rotate codes, revoke memberships — all with a
 * confirmation, a reason and an immutable audit entry. The two lists and the log
 * are their own routes (see `AdminNav` for why they are routes rather than
 * tabs); this page holds the two things that are not lists: the invitation form,
 * which is the only way into the private beta, and the job-health panel, which
 * is the only thing here anybody looks at when nothing is wrong.
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
        description="Invite organisers, inspect accounts and events, and act with an audit trail."
      />

      <div className="space-y-4">
        <AdminConsoleGate>
          <OrganiserInviteForm />
          <JobHealthPanel />
        </AdminConsoleGate>

        <Card>
          <SectionHeading
            title="What this console cannot do"
            description="Not a limitation to work around — the capability matrix has no row for either."
          />
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>
              <span className="text-ink">Look at guests&rsquo; photographs.</span> An admin can
              count a party&rsquo;s submissions and their bytes, and cannot open one. There is no
              image on any page in here.
            </li>
            <li>
              <span className="text-ink">Act as somebody else.</span> There is no impersonation, and
              admin powers never include host powers over another person&rsquo;s party — moderation
              is not on this list.
            </li>
            <li>
              <span className="text-ink">Take a reason back.</span> Every action writes an
              append-only row against your account.
            </li>
          </ul>
          <p className="mt-4 text-sm text-faint">
            <Link href="/admin/audit" className="text-accent underline underline-offset-2">
              Read the audit log
            </Link>{" "}
            to see what has been done, by whom, and why.
          </p>
        </Card>
      </div>
    </>
  );
}
