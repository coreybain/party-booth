"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import type { AdminActionCopy } from "@/lib/admin/actions";
import { cohostApi, adminApi, type CohostMember } from "@/lib/convex-api";

/**
 * The membership list for one event, with the revoke action.
 *
 * It reads `cohosts.list` rather than an admin-only query, and that is
 * deliberate: `membership.list` is in `globalAdmin`'s capability set already,
 * and `assertEventNotFrozen` lets an admin through a party it has just frozen on
 * purpose — so the console sees exactly the list the host sees. A second query
 * would be a second answer to one question, and the two would eventually
 * disagree about who is in the room.
 *
 * `membership.revoke` refuses `isSelf` and refuses an `owner` target, so this
 * cannot be used to decapitate a party from the console — an owner's seat only
 * goes away by transfer or by the event going. The owner's row is therefore
 * shown without a button rather than with one that always fails.
 */
export function EventMemberships({
  eventId,
  className,
}: {
  readonly eventId: string;
  readonly className?: string;
}) {
  const list = useQuery(cohostApi.list, { eventId });

  if (list === undefined) {
    return (
      <div className={className} role="status" aria-live="polite">
        <span className="sr-only">Loading the guest list…</span>
        <div className="h-16 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      </div>
    );
  }

  if (list.members.length === 0) {
    return (
      <p className={className} role="status">
        <span className="text-sm text-muted">Nobody has joined this party yet.</span>
      </p>
    );
  }

  return (
    <div className={className}>
      <h4 className="text-sm font-medium text-muted">Members</h4>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        {list.members.map((member) => (
          <MembershipRow key={member.membershipId} member={member} />
        ))}
      </ul>
    </div>
  );
}

const REVOKE_COPY: AdminActionCopy = {
  label: "Revoke",
  title: "Remove this person from the party?",
  consequences: [
    "They lose the party immediately — gallery, uploads and, for a co-host, the moderation queue.",
    "Any upload they had in flight is cancelled; the grant goes with the seat.",
    "What they already submitted stays where it is. This removes a person, not their photographs.",
    "A deliberate removal survives a code rotation, so scanning the new QR will not let them back in.",
  ],
  confirmLabel: "Revoke the membership",
  tone: "danger",
};

const ROLE_LABELS = { owner: "Host", cohost: "Co-host", guest: "Guest" } as const;

function MembershipRow({ member }: { readonly member: CohostMember }) {
  const revoke = useMutation(adminApi.revokeMembership);
  const [open, setOpen] = useState(false);

  const run = useCallback(
    async (reason: string) => {
      await revoke({ membershipId: member.membershipId, reason });
      setOpen(false);
    },
    [member.membershipId, revoke],
  );

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm text-ink">{member.displayName}</span>
          <StatusChip
            label={ROLE_LABELS[member.role]}
            tone={member.role === "guest" ? "neutral" : "progress"}
          />
        </div>
        {member.role === "owner" ? (
          <span className="text-sm text-faint">
            An owner&rsquo;s seat only goes with the event itself
          </span>
        ) : (
          <Button
            size="sm"
            variant="danger"
            aria-expanded={open}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            Revoke
          </Button>
        )}
      </div>

      {open ? (
        <ConfirmAction
          copy={REVOKE_COPY}
          subject={`${member.displayName} · ${ROLE_LABELS[member.role]}`}
          onConfirm={run}
          onCancel={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </li>
  );
}
