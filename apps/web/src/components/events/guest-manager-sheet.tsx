"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { MoreVerticalIcon, UsersIcon } from "@/components/icons";
import { Placeholder } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { AdminActionCopy } from "@/lib/admin/actions";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi, type GuestMember } from "@/lib/convex-api";
import { formatRelative } from "@/lib/datetime";
import { formatGuestCount } from "@/lib/event-view";
import { guestInitials } from "@/lib/guest-activity";
import { useNow } from "@/lib/use-now";

type GuestAction = "remove" | "ban";

const GUEST_ACTION_COPY: Record<GuestAction, AdminActionCopy> = {
  remove: {
    label: "Remove",
    title: "Remove this guest?",
    consequences: [
      "They lose this event immediately and any upload already in flight is cancelled.",
      "Their existing photos and videos stay with the event.",
      "They can scan the current QR or enter the current code to join again.",
    ],
    confirmLabel: "Remove guest",
    tone: "danger",
  },
  ban: {
    label: "Ban",
    title: "Ban this guest?",
    consequences: [
      "They lose this event immediately and any upload already in flight is cancelled.",
      "Their existing photos and videos stay with the event.",
      "They cannot rejoin this event with the current QR, code, or a future replacement.",
    ],
    confirmLabel: "Ban guest",
    tone: "danger",
  },
};

/**
 * The organiser's live guest roster. Radix owns focus trapping, Escape and
 * focus restoration; the trigger remains the compact count hosts already know.
 */
export function GuestManagerSheet({
  eventId,
  memberCount,
}: {
  readonly eventId: string;
  readonly memberCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-muted transition-colors after:absolute after:-inset-y-1 after:inset-x-0 hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={`Manage ${formatGuestCount(memberCount)}`}
        >
          <UsersIcon size={16} className="text-faint" />
          {formatGuestCount(memberCount)}
        </button>
      </SheetTrigger>

      <SheetContent className="max-w-2xl overflow-hidden p-0" closeLabel="Close guest manager">
        <GuestManagerContents eventId={eventId} active={open} />
      </SheetContent>
    </Sheet>
  );
}

function GuestManagerContents({
  eventId,
  active,
}: {
  readonly eventId: string;
  readonly active: boolean;
}) {
  const guests = useQuery(backendApi.memberships.guests, active ? { eventId } : "skip");
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return guests ?? [];
    return (guests ?? []).filter((guest) => guest.displayName.toLocaleLowerCase().includes(needle));
  }, [guests, search]);
  const totalUploads = (guests ?? []).reduce((total, guest) => total + guest.submissionCount, 0);

  return (
    <>
      <div className="border-b border-line px-5 pb-5 pt-6 sm:px-6">
        <SheetHeader>
          <SheetTitle>Guests</SheetTitle>
          <SheetDescription className="sr-only">
            See who is in this event and choose how their future uploads are handled.
          </SheetDescription>
        </SheetHeader>

        <dl className="mt-5 flex gap-8" aria-label="Guest summary">
          <div>
            <dt className="text-xs uppercase tracking-wide text-faint">In the event</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">
              {guests?.length ?? "—"}
            </dd>
          </div>
          {totalUploads > 0 ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-faint">Uploads</dt>
              <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">
                {totalUploads}
              </dd>
            </div>
          ) : null}
        </dl>

        <label className="mt-5 block">
          <span className="sr-only">Search guests</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search guests"
            className="h-11 w-full rounded-xl border border-line bg-raised px-3.5 text-sm text-ink outline-none placeholder:text-faint hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2 sm:px-6">
        {guests === undefined ? (
          <GuestListSkeleton />
        ) : guests.length === 0 ? (
          <Placeholder className="my-5" title="No guests yet">
            Share the event QR or join code. Guests appear here as soon as they enter.
          </Placeholder>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted" role="status">
            No guest matches “{search.trim()}”.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((guest) => (
              <GuestRow key={guest.membershipId} eventId={eventId} guest={guest} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function GuestRow({ eventId, guest }: { readonly eventId: string; readonly guest: GuestMember }) {
  const now = useNow();
  const setAutoApprove = useMutation(backendApi.memberships.setAutoApprove);
  const removeGuest = useMutation(backendApi.memberships.removeGuest);
  const [pendingTrust, setPendingTrust] = useState(false);
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<GuestAction>();

  const updateTrust = useCallback(
    async (enabled: boolean) => {
      setPendingTrust(true);
      setError(undefined);
      try {
        await setAutoApprove({ eventId, userId: guest.userId, enabled });
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPendingTrust(false);
      }
    },
    [eventId, guest.userId, setAutoApprove],
  );

  const act = useCallback(
    async (reason: string) => {
      if (action === undefined) return;
      await removeGuest({ eventId, userId: guest.userId, action, reason });
      setAction(undefined);
    },
    [action, eventId, guest.userId, removeGuest],
  );

  const joined = now === 0 ? "Joined this event" : `Joined ${formatRelative(guest.joinedAt, now)}`;

  return (
    <li className="py-5">
      <div className="flex items-start gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/20 bg-accent/10 text-sm font-semibold text-accent"
          aria-hidden="true"
        >
          {guestInitials(guest.displayName)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink" title={guest.displayName}>
                {guest.displayName}
              </p>
              <p className="mt-0.5 text-sm text-muted">{joined}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {guest.submissionCount > 0 ? (
                <p className="text-sm tabular-nums text-muted">
                  {guest.submissionCount} {guest.submissionCount === 1 ? "upload" : "uploads"}
                  {guest.approvedCount > 0 ? (
                    <span className="text-faint"> · {guest.approvedCount} approved</span>
                  ) : null}
                </p>
              ) : null}
              <GuestActionsMenu
                guest={guest}
                pending={pendingTrust}
                onAutoApprove={(enabled) => {
                  void updateTrust(enabled);
                }}
                onAction={setAction}
              />
            </div>
          </div>

          {error ? (
            <Callout tone="danger" live="assertive" className="mt-3">
              {error}
            </Callout>
          ) : null}

          {action ? (
            <ConfirmAction
              key={action}
              copy={GUEST_ACTION_COPY[action]}
              subject={guest.displayName}
              onConfirm={act}
              onCancel={() => {
                setAction(undefined);
              }}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function GuestActionsMenu({
  guest,
  pending,
  onAutoApprove,
  onAction,
}: {
  readonly guest: GuestMember;
  readonly pending: boolean;
  readonly onAutoApprove: (enabled: boolean) => void;
  readonly onAction: (action: GuestAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="md"
          className="size-11 rounded-full px-0"
          disabled={pending}
          aria-label={`Actions for ${guest.displayName}`}
          title={`Actions for ${guest.displayName}`}
        >
          <MoreVerticalIcon size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuItem
          disabled={pending}
          onSelect={() => {
            onAutoApprove(!guest.autoApproveMedia);
          }}
        >
          {guest.autoApproveMedia ? "Turn off auto-approval" : "Auto-approve future uploads"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onAction("remove");
          }}
        >
          Remove from event
        </DropdownMenuItem>
        <DropdownMenuItem
          tone="danger"
          onSelect={() => {
            onAction("ban");
          }}
        >
          Ban from event
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GuestListSkeleton() {
  return (
    <div className="space-y-1 py-2" role="status" aria-live="polite">
      <span className="sr-only">Loading guests…</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-3 border-b border-line py-5" aria-hidden="true">
          <div className="size-11 shrink-0 animate-pulse rounded-full bg-raised" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/5 animate-pulse rounded bg-raised" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}
