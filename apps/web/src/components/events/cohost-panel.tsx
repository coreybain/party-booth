"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useState, type FormEvent } from "react";

import { Placeholder } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { TextField } from "@/components/ui/text-field";
import { UsersIcon } from "@/components/icons";
import { appErrorMessage } from "@/lib/app-errors";
import {
  checkCohostEmail,
  COHOST_POWERS,
  cohostPanelMode,
  hostRoster,
  invitationExpiryLabel,
} from "@/lib/cohosts";
import { cohostApi, type CohostInvitation, type CohostMember } from "@/lib/convex-api";
import { useNow } from "@/lib/use-now";

/**
 * Co-hosts: who is helping run the party, and who has been asked.
 *
 * PLAN.md keeps co-hosts in launch scope and TODO.md draws the line — "no
 * delete/transfer/ownership". The panel is built so that line is visible rather
 * than merely enforced:
 *
 * - **The owner manages; a co-host reads.** Which one you get comes from
 *   `cohosts.list().canInvite`, computed server-side from the same predicate
 *   `createInvitation` enforces. Nothing here compares roles, so the read-only
 *   view and the mutation's refusal are one decision.
 * - **The pending-invitation list is the owner's.** `cohosts.list` returns an
 *   empty array of invitations to a co-host on purpose — an address somebody
 *   typed is not something the whole host bench needs.
 * - **Removing a co-host is one action, not two.** `cohosts.remove` revokes the
 *   membership *and* any pending invitation to the same address, because
 *   otherwise verified-email matching quietly re-grants the seat at their next
 *   sign-in.
 */
export function CohostPanel({
  eventId,
  ownEmail,
  className,
}: {
  readonly eventId: string;
  readonly ownEmail?: string;
  readonly className?: string;
}) {
  const list = useQuery(cohostApi.list, { eventId });
  // `0` until the first client commit — see `useNow`. The expiry label is
  // suppressed rather than rendered against the epoch.
  const now = useNow();

  if (list === undefined) {
    return (
      <div className={className} role="status" aria-live="polite">
        <span className="sr-only">Loading the host list…</span>
        <div className="h-24 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      </div>
    );
  }

  const roster = hostRoster(list.members);
  const mode = cohostPanelMode(list);

  return (
    <div className={className}>
      <HostList
        owner={roster.owner}
        cohosts={roster.cohosts}
        eventId={eventId}
        canManage={mode === "manage"}
      />

      {mode === "manage" ? (
        <>
          <PendingInvitations invitations={list.invitations} now={now} />
          <InviteForm
            eventId={eventId}
            invitations={list.invitations}
            {...(ownEmail === undefined ? {} : { ownEmail })}
          />
        </>
      ) : (
        <CohostPowers />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Who is in                                                                  */
/* -------------------------------------------------------------------------- */

function HostList({
  owner,
  cohosts,
  eventId,
  canManage,
}: {
  readonly owner?: CohostMember;
  readonly cohosts: readonly CohostMember[];
  readonly eventId: string;
  readonly canManage: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {owner === undefined ? null : (
        <li className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{owner.displayName}</p>
            <p className="text-sm text-muted">Host — runs the party and owns it</p>
          </div>
        </li>
      )}

      {cohosts.map((cohost) => (
        <li
          key={cohost.membershipId}
          className="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{cohost.displayName}</p>
            <p className="text-sm text-muted">Co-host</p>
          </div>
          {canManage ? <RemoveCohost eventId={eventId} cohost={cohost} /> : null}
        </li>
      ))}

      {cohosts.length === 0 ? (
        <li className="py-3">
          <p className="text-sm text-muted">
            <UsersIcon size={16} className="mr-1.5 inline-block align-[-2px] text-faint" />
            No co-hosts yet. One extra pair of hands is the difference between moderating the party
            and attending it.
          </p>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Removing a co-host, behind a confirmation.
 *
 * The confirmation exists because the person being removed is not in the room to
 * object, and because the sentence underneath is the only place the second write
 * — burning any outstanding invitation to the same address — is visible.
 */
function RemoveCohost({
  eventId,
  cohost,
}: {
  readonly eventId: string;
  readonly cohost: CohostMember;
}) {
  const remove = useMutation(cohostApi.remove);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const apply = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await remove({ eventId, userId: cohost.userId });
      setConfirming(false);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [cohost.userId, eventId, remove]);

  if (!confirming) {
    return (
      <Button
        variant="danger"
        size="sm"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Remove
      </Button>
    );
  }

  return (
    <div className="w-full">
      <Callout tone="warning" live="polite">
        <p className="text-ink">Remove {cohost.displayName} as a co-host?</p>
        <p className="mt-1">
          They lose the moderation queue, the join code and the slideshow immediately. Any
          invitation still sitting in their inbox is cancelled with it, so they cannot walk straight
          back in. Photo links their screen had already loaded keep working for up to a minute —
          nothing new is issued. Nothing they approved is undone, and they stay a guest of the
          party.
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            variant="danger"
            size="sm"
            loading={pending}
            onClick={() => {
              void apply();
            }}
          >
            Remove co-host
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
              setError(undefined);
            }}
          >
            Keep them
          </Button>
        </div>
      </Callout>
      {error === undefined ? null : (
        <Callout tone="danger" live="assertive" className="mt-2">
          {error}
        </Callout>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Who has been asked                                                         */
/* -------------------------------------------------------------------------- */

function PendingInvitations({
  invitations,
  now,
}: {
  readonly invitations: readonly CohostInvitation[];
  readonly now: number;
}) {
  const pending = invitations.filter((invitation) => invitation.status === "pending");
  if (pending.length === 0) return null;

  return (
    <div className="mt-5">
      <h3 className="text-sm font-medium text-muted">Invited, not yet accepted</h3>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        {pending.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{invitation.email}</p>
              {now === 0 ? null : (
                <p className="text-sm text-faint">
                  {invitationExpiryLabel(invitation.expiresAt, now)}
                </p>
              )}
            </div>
            <RevokeInvitation invitationId={invitation.id} email={invitation.email} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-faint">
        They become a co-host the first time they sign in with this exact address, verified.
        Forwarding the email gets somebody else nothing.
      </p>
    </div>
  );
}

function RevokeInvitation({
  invitationId,
  email,
}: {
  readonly invitationId: string;
  readonly email: string;
}) {
  const revoke = useMutation(cohostApi.revokeInvitation);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const apply = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await revoke({ invitationId });
      setConfirming(false);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [invitationId, revoke]);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Cancel invite
      </Button>
    );
  }

  return (
    <div className="w-full">
      <Callout tone="warning" live="polite">
        <p className="text-ink">Cancel the invitation to {email}?</p>
        <p className="mt-1">
          The link in their email stops working straight away, and signing in with that address no
          longer makes them a co-host.
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            variant="danger"
            size="sm"
            loading={pending}
            onClick={() => {
              void apply();
            }}
          >
            Cancel the invitation
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
            }}
          >
            Leave it open
          </Button>
        </div>
      </Callout>
      {error === undefined ? null : (
        <Callout tone="danger" live="assertive" className="mt-2">
          {error}
        </Callout>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inviting                                                                   */
/* -------------------------------------------------------------------------- */

function InviteForm({
  eventId,
  invitations,
  ownEmail,
}: {
  readonly eventId: string;
  readonly invitations: readonly CohostInvitation[];
  readonly ownEmail?: string;
}) {
  const invite = useAction(cohostApi.invite);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);

  const submit = useCallback(
    async (formEvent: FormEvent<HTMLFormElement>) => {
      formEvent.preventDefault();
      setSentTo(undefined);

      const checked = checkCohostEmail(value, {
        ...(ownEmail === undefined ? {} : { ownEmail }),
        existing: invitations,
      });
      if (!checked.ok) {
        setError(checked.error);
        return;
      }

      setPending(true);
      setError(undefined);
      try {
        await invite({ eventId, email: checked.email });
        setSentTo(checked.email);
        setValue("");
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPending(false);
      }
    },
    [eventId, invitations, invite, ownEmail, value],
  );

  return (
    <form
      className="mt-5 border-t border-line pt-5"
      onSubmit={(formEvent) => {
        void submit(formEvent);
      }}
      noValidate
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <TextField
            label="Invite a co-host"
            name="cohost-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="them@example.com"
            value={value}
            onChange={(changeEvent) => {
              setValue(changeEvent.target.value);
              setError(undefined);
            }}
            {...(error === undefined ? {} : { error })}
            hint="They get an email. The seat only lands when they sign in with this address, verified."
          />
        </div>
        <Button type="submit" loading={pending} disabled={value.trim().length === 0}>
          Send invite
        </Button>
      </div>

      {sentTo === undefined ? null : (
        <Callout tone="success" live="polite" className="mt-3">
          Invitation sent to {sentTo}. It is good for fourteen days.
        </Callout>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* The co-host's own view                                                     */
/* -------------------------------------------------------------------------- */

/** What a co-host sees instead of the controls: the boundaries of the role. */
function CohostPowers() {
  return (
    <div className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
      <div>
        <h3 className="text-sm font-medium text-ink">As a co-host you can</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          {COHOST_POWERS.can.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-medium text-ink">Only the host can</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          {COHOST_POWERS.cannot.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The panel with nothing behind it — used while no event is selected. */
export function CohostPanelPlaceholder({ className }: { readonly className?: string }) {
  return (
    <Placeholder className={className} title="No event selected">
      Pick an event from the switcher at the top to see its host list.
    </Placeholder>
  );
}
