import { PageHeader } from "@/components/layout/app-shell";
import { Card, Placeholder, SectionHeading } from "@/components/layout/card";

/**
 * Global-admin console. PLAN.md → invite organisers, inspect accounts and
 * events, lock/unlock, schedule/restore deletion, rotate codes, revoke
 * memberships — all with a confirmation, a reason and an immutable audit entry.
 *
 * Explicitly *not* here, now or later: media access and impersonation.
 */
export default function AdminHomePage() {
  return (
    <>
      <PageHeader
        title="Console"
        description="Invite organisers, inspect accounts and events, and act with an audit trail."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <SectionHeading
            title="Organiser invitations"
            description="The only way into the private beta."
          />
          <Placeholder className="mt-4" title="No invitations yet" sprint="Sprint 5" />
        </Card>

        <Card>
          <SectionHeading
            title="Accounts"
            description="Lock, unlock, schedule or restore deletion."
          />
          <Placeholder className="mt-4" title="No accounts yet" sprint="Sprint 5" />
        </Card>

        <Card>
          <SectionHeading
            title="Events"
            description="Asset counts, storage usage and code rotation."
          />
          <Placeholder className="mt-4" title="No events yet" sprint="Sprint 5" />
        </Card>

        <Card>
          <SectionHeading
            title="Audit log"
            description="Append-only. Every action, actor and reason."
          />
          <Placeholder className="mt-4" title="Nothing recorded yet" sprint="Sprint 5" />
        </Card>
      </div>

      <p className="mt-6 text-xs text-faint">
        This console never exposes guest media and cannot impersonate a user.
      </p>
    </>
  );
}
